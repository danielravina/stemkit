import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_TEMPO, type AppSettings, type Song, type StemId, type MixChannelId, type StemPanMap, type TempoSettings, type TempoAnalysis } from '../../../shared/types'
import { engine, decodePayload, type BufferMap } from '../lib/engine'
import { buildStemMeta } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { SongThumb } from '../lib/thumbs'
import { YouTubeHost, type YTState } from '../lib/youtube'
import { StemLane } from './StemLane'
import { Transport, type PresetId } from './Transport'
import { DownloadIcon } from './Icons'
import { TempoDetector, tempoAt, manualBeats, practiceRate, playbackAnalysis } from '../lib/tempo-client'
import { metronomePeaks } from '../../../shared/metronome'
import { CountInControls } from './CountInControls'
import { MetronomeLane } from './MetronomeLane'

// number keys 1-6 mute the lane shown in that position, top to bottom
const STEM_KEYS = ['1', '2', '3', '4', '5', '6']

type BufferCacheMap = BufferMap

const bufferCache = new Map<string, Promise<BufferCacheMap>>()

function getDecoded(videoId: string): Promise<BufferCacheMap> {
  let entry = bufferCache.get(videoId)
  if (!entry) {
    entry = window.stemkit
      .getBuffers(videoId)
      .then((payload) => decodePayload(payload))
      .catch((err) => {
        bufferCache.delete(videoId)
        throw err
      })
    bufferCache.set(videoId, entry)
  }
  return entry
}

interface Props {
  song: Song
  settings?: AppSettings
}

export function Player({ song, settings }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<YouTubeHost | null>(null)
  const posRef = useRef(0)
  const playingRef = useRef(false)
  const videoSyncAtRef = useRef(0)
  const phaseRef = useRef<'paused' | 'analyzing' | 'counting' | 'playing'>('paused')
  const playRequest = useRef(0)
  const detector = useRef(new TempoDetector())
  const visualDetector = useRef(new TempoDetector())
  const visualAnalysis = useRef<TempoAnalysis | null>(null)
  const [detectingTempo, setDetectingTempo] = useState(true)
  const [visualBeats, setVisualBeats] = useState<{ songId: string; beats: number[] } | null>(null)
  const tempoRevision = useRef(0)
  const [tempo, setTempo] = useState<TempoSettings>({ ...DEFAULT_TEMPO })
  const [detectedBpm, setDetectedBpm] = useState<number | null>(null)
  const [countInBars, setCountInBars] = useState<0 | 1 | 2 | 3 | 4>(settings?.countInBars ?? 0)
  const [clickVolume, setClickVolume] = useState(settings?.clickVolume ?? 0.5)
  const autoAnalysis = useRef<TempoAnalysis | null>(null)
  const [countError, setCountError] = useState<string | null>(null)
  const [tempoSaveError, setTempoSaveError] = useState<string | null>(null)

  const VIDEO_DRIFT_LIMIT = 0.4
  const VIDEO_RESYNC_COOLDOWN = 2000

  const [ytReady, setYtReady] = useState(false)
  const [decoding, setDecoding] = useState(true)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(song.duration || 0)
  const [bump, setBump] = useState(0)
  const [buffers, setBuffers] = useState<BufferMap>({})

  const [vols, setVols] = useState<Partial<Record<StemId, number>>>({})
  const [pans, setPans] = useState<StemPanMap>({})
  const [panError, setPanError] = useState<string | null>(null)
  const pansRef = useRef<StemPanMap>({})
  const panSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPan = useRef<{ videoId: string; pans: StemPanMap } | null>(null)
  const panGeneration = useRef(0)
  const panRevision = useRef(0)
  const [mutes, setMutes] = useState<Set<MixChannelId>>(new Set(settings?.metronomeEnabled ? [] : ['metronome']))
  const [solos, setSolos] = useState<Set<MixChannelId>>(new Set())
  const metronomeEnabled = !mutes.has('metronome')
  const metronomeAudible = metronomeEnabled && (solos.size === 0 || solos.has('metronome'))
  const [master, setMaster] = useState(0.9)
  const [preset, setPreset] = useState<PresetId | 'custom'>('all')

  const cancelPlayback = useCallback((): void => {
    ++playRequest.current
    detector.current.cancel()
    if (playingRef.current) posRef.current = engine.expected()
    playingRef.current = false
    phaseRef.current = 'paused'
    engine.setPlaying(false, posRef.current)
    hostRef.current?.pause()
    setPlaying(false)
  }, [])

  useEffect(() => {
    const bars = settings?.countInBars ?? 0
    if (bars !== countInBars) {
      setCountInBars(bars)
      if (phaseRef.current === 'analyzing' || phaseRef.current === 'counting') cancelPlayback()
    }
  }, [settings?.countInBars, cancelPlayback])

  useEffect(() => {
    setMutes(previous => {
      const next = new Set(previous)
      if (settings?.metronomeEnabled) next.delete('metronome')
      else next.add('metronome')
      return next
    })
  }, [settings?.metronomeEnabled])

  useEffect(() => {
    const volume = settings?.clickVolume ?? 0.5
    setClickVolume(volume)
    engine.setClickVolume(volume)
  }, [settings?.clickVolume])

  useEffect(() => {
    if (phaseRef.current === 'analyzing') { cancelPlayback(); return }
    if (phaseRef.current !== 'playing' && phaseRef.current !== 'counting') return
    let cancelled = false
    void (async () => {
      const analysis = visualAnalysis.current ?? await playbackAnalysis(detector.current, song.videoId, tempo.mode === 'manual')
      if (cancelled || phaseRef.current === 'paused' || phaseRef.current === 'analyzing') return
      autoAnalysis.current = analysis
      const rate = practiceRate(tempo, analysis)
      const beats = analysis.beats.length ? analysis.beats : manualBeats((tempo.manualBpm ?? 0) / rate, engine.trackDuration())
      engine.setMetronome(metronomeAudible ? beats : null)
      const applied = await engine.setRate(rate)
      if (applied && !cancelled) hostRef.current?.setRate(rate)
      if (metronomeAudible && !beats.length) throw new Error('No reliable beats found. Enter BPM manually or turn the metronome Off.')
    })().catch(error => {
      if (cancelled || (error instanceof Error && error.name === 'AbortError')) return
      cancelPlayback()
      setCountError(error instanceof Error ? error.message : 'Could not change practice tempo.')
    })
    return () => { cancelled = true }
  }, [metronomeAudible, tempo, song.videoId, cancelPlayback])

  const stemMeta = useMemo(() => buildStemMeta(Object.keys(buffers) as StemId[]), [buffers])

  useEffect(() => {
    setVisualBeats(null)
    visualAnalysis.current = null
    setDetectingTempo(true)
    if (decoding || decodeError) return
    let cancelled = false
    const analyzer = visualDetector.current
    void analyzer.analyze(song.videoId).then(analysis => {
      if (cancelled) return
      visualAnalysis.current = analysis
      setVisualBeats({ songId: song.videoId, beats: analysis.beats })
      setDetectedBpm(tempoAt(analysis.points, posRef.current))
      setDetectingTempo(false)
    }).catch(() => {
      if (!cancelled) {
        visualAnalysis.current = { points: [], beats: [] }
        setVisualBeats({ songId: song.videoId, beats: [] })
        setDetectingTempo(false)
      }
    })
    return () => { cancelled = true; analyzer.cancel() }
  }, [song.videoId, decoding, decodeError])

  const metronomeWaveform = useMemo(() => {
    const beats = visualBeats?.songId === song.videoId && visualBeats.beats.length ? visualBeats.beats
      : tempo.mode === 'manual' ? manualBeats(tempo.sourceBpm ?? tempo.manualBpm ?? 0, duration) : null
    return beats ? metronomePeaks(beats, duration) : null
  }, [visualBeats, song.videoId, duration, tempo.mode, tempo.manualBpm, tempo.sourceBpm])

  // local files have no video to sync: the player runs audio-only, with a
  // placeholder panel where the YouTube iframe would be
  const isLocal = song.source === 'local'
  const youtubeUrl = isLocal ? null : `https://www.youtube.com/watch?v=${song.videoId}`
  // stems always play locally from the library; hiding the video just stops
  // streaming it from YouTube (and switches thumbnails to the local cache)
  const showVideo = !(settings?.hideVideo ?? false) && !isLocal
  const addedLabel = new Date(song.addedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })

  useEffect(() => {
    cancelPlayback()
    ++tempoRevision.current
    setTempo({ ...DEFAULT_TEMPO })
    autoAnalysis.current = null
    setDetectedBpm(null)
    setCountError(null)
    setTempoSaveError(null)
    const generation = ++panGeneration.current
    setPans({})
    pansRef.current = {}
    setPanError(null)
    posRef.current = 0
    setPlaying(false)
    playingRef.current = false
    videoSyncAtRef.current = 0
    setYtReady(false)
    setDecodeError(null)
    setBuffers({})
    setDuration(song.duration || 0)
    setVols({})
    setMutes(previous => new Set(previous.has('metronome') ? ['metronome'] : []))
    setSolos(new Set())
    setPreset('all')
    engine.stopAll()

    let cancelled = false
    const flushPan = (): void => {
      if (panSaveTimer.current !== null) clearTimeout(panSaveTimer.current)
      panSaveTimer.current = null
      const pending = pendingPan.current
      pendingPan.current = null
      if (pending) void window.stemkit.setStemPan(pending.videoId, pending.pans).catch(() => {})
    }
    window.addEventListener('beforeunload', flushPan)
    setDecoding(true)
    Promise.all([
      getDecoded(song.videoId),
      window.stemkit.getStemPan(song.videoId).catch(() => {
        if (!cancelled) setPanError('Could not load saved pan settings. Using center.')
        return {} as StemPanMap
      }),
      window.stemkit.getTempoSettings(song.videoId).catch(() => {
        if (!cancelled) setTempoSaveError('Could not load tempo settings. Using Auto and 4 beats per bar.')
        return { ...DEFAULT_TEMPO }
      })
    ])
      .then(([decoded, savedPan, savedTempo]) => {
        if (cancelled) return
        const initialPans = Object.fromEntries([...Object.keys(decoded), 'metronome'].map((id) => {
          const value = savedPan[id as MixChannelId]
          return [id, typeof value === 'number' && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0]
        })) as StemPanMap
        pansRef.current = initialPans
        setPans(initialPans)
        setTempo(savedTempo)
        setBuffers(decoded)
        engine.setBuffers(decoded)
        setVols(Object.fromEntries(Object.keys(decoded).map((id) => [id, 1])))
        const d = engine.trackDuration()
        if (d > 0) setDuration(d)
        setDecoding(false)
      })
      .catch((err) => {
        if (cancelled) return
        setDecoding(false)
        setDecodeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      cancelPlayback()
      ++tempoRevision.current
      if (panGeneration.current === generation) ++panGeneration.current
      window.removeEventListener('beforeunload', flushPan)
      flushPan()
      engine.stopAll()
      hostRef.current?.destroy()
      hostRef.current = null
    }
  }, [song.videoId, cancelPlayback])

  useEffect(() => {
    if (!showVideo) {
      hostRef.current?.destroy()
      hostRef.current = null
      setYtReady(false)
      return
    }
    if (decoding || decodeError || hostRef.current) return
    let disposed = false
    const container = containerRef.current
    if (!container) return

    const host = new YouTubeHost()
    hostRef.current = host
    void host
      .mount(container, song.videoId, (state: YTState) => {
        if (disposed || !engine.hasBuffers()) return
        if (state === 'playing') {
          videoSyncAtRef.current = 0
          if (!playingRef.current) {
            host.pause()
          }
        }
      })
      .then(() => {
        if (!disposed) { host.setRate(engine.rate); setYtReady(true) }
      })

    return () => {
      disposed = true
    }
    return () => {
      disposed = true
    }
  }, [song.videoId, decoding, decodeError, showVideo])

  useEffect(() => {
    engine.applyMix(vols, mutes, solos, master, pans)
  }, [vols, mutes, solos, master, pans])

  const changePan = (id: MixChannelId, value: number): void => {
    const next = { ...pansRef.current, [id]: value }
    pansRef.current = next
    setPans(next)
    const generation = panGeneration.current
    const revision = ++panRevision.current
    pendingPan.current = { videoId: song.videoId, pans: next }
    if (panSaveTimer.current !== null) clearTimeout(panSaveTimer.current)
    panSaveTimer.current = setTimeout(() => {
      panSaveTimer.current = null
      const pending = pendingPan.current
      pendingPan.current = null
      if (!pending) return
      void window.stemkit.setStemPan(pending.videoId, pending.pans).then(() => {
        if (generation === panGeneration.current && revision === panRevision.current) setPanError(null)
      }).catch(() => {
        if (generation === panGeneration.current && revision === panRevision.current) {
          setPanError('Could not save pan settings. Your live pan is still applied.')
        }
      })
    }, 250)
  }

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      if (phaseRef.current === 'paused' || phaseRef.current === 'analyzing') return
      if (engine.phase() === 'counting') return
      if (phaseRef.current === 'counting') {
        phaseRef.current = 'playing'
        playingRef.current = true
        hostRef.current?.setRate(engine.rate)
        hostRef.current?.seek(engine.expected())
        hostRef.current?.play()
      }
      posRef.current = engine.expected()
      const analysis = autoAnalysis.current ?? visualAnalysis.current
      if (analysis) setDetectedBpm(tempoAt(analysis.points, posRef.current))

      const dur = engine.trackDuration()
      if (dur > 0 && posRef.current >= dur - 0.03) {
        posRef.current = dur
        engine.stopAll()
        phaseRef.current = 'paused'
        playingRef.current = false
        setPlaying(false)
        hostRef.current?.pause()
        setBump((n) => n + 1)
        return
      }

      const now = performance.now()
      if (now - videoSyncAtRef.current > VIDEO_RESYNC_COOLDOWN) {
        const v = hostRef.current?.time() ?? 0
        if (Math.abs(v - posRef.current) > VIDEO_DRIFT_LIMIT) {
          videoSyncAtRef.current = now
          hostRef.current?.seek(posRef.current)
        }
      }
    }
    const loop = (): void => {
      tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const backup = setInterval(tick, 400)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(backup)
    }
  }, [playing, countInBars, tempo])

  useEffect(() => {
    const id = setInterval(() => {
      const d = hostRef.current?.duration() ?? 0
      if (d > 0) {
        setDuration((prev) => (Math.abs(prev - d) > 0.5 ? d : prev))
      }
    }, 600)
    return () => clearInterval(id)
  }, [])

  const togglePlay = useCallback((): void => {
    if (decoding || decodeError) return
    if (phaseRef.current !== 'paused') {
      cancelPlayback()
      return
    }
    const request = ++playRequest.current
    if (posRef.current >= engine.trackDuration() - 0.05) posRef.current = 0
    const position = posRef.current
    phaseRef.current = 'analyzing'
    setPlaying(true)
    setCountError(null)
    const needsTempo = !!countInBars || metronomeAudible
    void (async () => {
      try {
        const analysis = visualAnalysis.current ?? (needsTempo || tempo.mode === 'manual'
          ? await playbackAnalysis(detector.current, song.videoId, tempo.mode === 'manual') : null)
        const rate = practiceRate(tempo, analysis)
        const localBpm = analysis ? tempoAt(analysis.points, position) : null
        const bpm = needsTempo ? localBpm !== null ? localBpm * rate : tempo.manualBpm : null
        if (request !== playRequest.current) return
        if (needsTempo && bpm === null) {
          cancelPlayback()
          setDetectedBpm(null)
          setCountError(tempo.mode === 'manual'
            ? 'Enter a BPM between 30 and 300, or turn clicks Off.'
            : 'No reliable tempo found here. Enter BPM manually or turn clicks Off.')
          return
        }
        autoAnalysis.current = analysis
        if (needsTempo && tempo.mode === 'auto') setDetectedBpm(bpm)
        const beats = metronomeAudible ? analysis?.beats.length ? analysis.beats : manualBeats((bpm ?? 0) / rate, engine.trackDuration()) : null
        if (metronomeAudible && !beats?.length) {
          cancelPlayback()
          setCountError('No reliable beats found. Enter BPM manually or turn the metronome Off.')
          return
        }
        const applied = await engine.setRate(rate)
        if (!applied || request !== playRequest.current) return
        hostRef.current?.setRate(rate)
        engine.setMetronome(beats)
        const started = await engine.start(position, countInBars && bpm !== null ? { bars: countInBars, bpm, beatsPerBar: tempo.beatsPerBar } : undefined)
        if (!started || request !== playRequest.current) return
        if (countInBars) {
          phaseRef.current = 'counting'
        } else {
          phaseRef.current = 'playing'
          playingRef.current = true
          hostRef.current?.play()
        }
      } catch (error) {
        if (request !== playRequest.current) return
        cancelPlayback()
        setCountError(error instanceof Error ? error.message : 'Could not start playback.')
      }
    })()
  }, [decoding, decodeError, cancelPlayback, countInBars, tempo, song.videoId, metronomeAudible])

  const seekTo = useCallback(
    (t: number): void => {
      if (phaseRef.current === 'analyzing' || phaseRef.current === 'counting') cancelPlayback()
      const clamped = Math.max(0, Math.min(duration > 0 ? duration - 0.05 : t, t))
      const analysis = autoAnalysis.current ?? visualAnalysis.current
      setDetectedBpm(analysis ? tempoAt(analysis.points, clamped) : null)
      setCountError(null)
      posRef.current = clamped
      void engine.setPlaying(playingRef.current, clamped).then(applied => {
        if (applied) hostRef.current?.setRate(engine.rate)
      }).catch(error => {
        cancelPlayback()
        setCountError(error instanceof Error ? error.message : 'Could not seek playback.')
      })
      videoSyncAtRef.current = performance.now()
      hostRef.current?.seek(clamped)
      setBump((n) => n + 1)
    },
    [duration, cancelPlayback, tempo.mode]
  )

  const changeTempo = (next: TempoSettings): void => {
    if (phaseRef.current === 'analyzing' || phaseRef.current === 'counting') cancelPlayback()
    setTempo(next)
    setCountError(null)
    const revision = ++tempoRevision.current
    if (next.mode === 'manual' && next.manualBpm === null) return
    void window.stemkit.setTempoSettings(song.videoId, next).then(() => {
      if (revision === tempoRevision.current) setTempoSaveError(null)
    }).catch(() => {
      if (revision === tempoRevision.current) setTempoSaveError('Could not save tempo settings. Your live settings are still applied.')
    })
  }

  const changeCountInBars = (bars: 0 | 1 | 2 | 3 | 4): void => {
    if (phaseRef.current === 'analyzing' || phaseRef.current === 'counting') cancelPlayback()
    setCountInBars(bars)
    setCountError(null)
    const revision = ++tempoRevision.current
    void window.stemkit.setSettings({ countInBars: bars }).then(() => {
      if (revision === tempoRevision.current) setTempoSaveError(null)
    }).catch(() => {
      if (revision === tempoRevision.current) setTempoSaveError('Could not save count-in preference. Your live selection is still applied.')
    })
  }

  const changeClickVolume = (volume: number): void => {
    setClickVolume(volume)
    engine.setClickVolume(volume)
  }

  const saveClickVolume = (): void => {
    if (clickVolume === settings?.clickVolume) return
    void window.stemkit.setSettings({ clickVolume }).catch(() => {
      setTempoSaveError('Could not save click volume. Your live volume is still applied.')
    })
  }

  const getPosition = useCallback((): number => {
    void bump
    return posRef.current
  }, [bump])

  // Practice speed affects playback only; downloads keep the original song's timing.
  const exportTempo = (): TempoSettings => {
    if (visualAnalysis.current?.beats.length) return { ...tempo, mode: 'auto', manualBpm: null }
    if (tempo.sourceBpm) return { ...tempo, mode: 'manual', manualBpm: tempo.sourceBpm }
    return visualAnalysis.current ? tempo : { ...tempo, mode: 'auto', manualBpm: null }
  }

  const exportStem = useCallback(
    (stem: string): void => {
      void window.stemkit.exportStem(song.videoId, stem, stem === 'metronome' ? exportTempo() : undefined).catch(error => {
        setCountError(error instanceof Error ? error.message : 'Could not export the track.')
      })
    },
    [song.videoId, tempo]
  )

  const exportAllStems = useCallback((): void => {
    void window.stemkit.exportAllStems(song.videoId, exportTempo()).then(result => {
      if (result.warning) setCountError(result.warning)
    }).catch(error => {
      setCountError(error instanceof Error ? error.message : 'Could not export tracks.')
    })
  }, [song.videoId, tempo])



  const applyPreset = (p: PresetId): void => {
    setPreset(p)
    setMutes(previous => new Set(previous.has('metronome') ? ['metronome'] : []))
    if (p === 'all') setSolos(new Set())
    else if (p === 'karaoke')
      setSolos(new Set<MixChannelId>(stemMeta.filter((s) => s.id !== 'vocals').map((s) => s.id)))
    else if (p === 'acapella') setSolos(new Set<MixChannelId>(['vocals']))
    else if (p === 'drumnbass') setSolos(new Set<MixChannelId>(['drums', 'bass']))
  }

  const toggleMute = useCallback(
    (id: MixChannelId): void => {
      setPreset('custom')
      const turningOn = !mutes.has(id)
      if (id === 'metronome') {
        if (phaseRef.current === 'analyzing') cancelPlayback()
        setCountError(null)
        if (turningOn) engine.setMetronome(null)
        void window.stemkit.setSettings({ metronomeEnabled: !turningOn }).catch(() => {
          setTempoSaveError('Could not save metronome preference. Your live selection is still applied.')
        })
      }
      if (turningOn && solos.has(id)) {
        setSolos((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
      setMutes((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [mutes, solos, cancelPlayback]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && (e.target.closest('input, select, textarea') || e.target.isContentEditable)) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
        return
      }
      const lane = STEM_KEYS.indexOf(e.key)
      if (lane !== -1 && lane < stemMeta.length && !e.altKey && !e.ctrlKey && !e.metaKey) {
        toggleMute(stemMeta[lane].id)
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        if (decoding || decodeError) return
        e.preventDefault()
        const step = e.shiftKey ? 15 : 5
        seekTo(posRef.current + (e.code === 'ArrowLeft' ? -step : step))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, toggleMute, stemMeta, seekTo, decoding, decodeError])

  const toggleSolo = (id: MixChannelId): void => {
    setPreset('custom')
    const turningOn = !solos.has(id)
    if (turningOn && mutes.has(id)) {
      if (id === 'metronome') {
        void window.stemkit.setSettings({ metronomeEnabled: true }).catch(() => {
          setTempoSaveError('Could not save metronome preference. Your live selection is still applied.')
        })
      }
      setMutes((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
    setSolos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const controlTempo = tempo.mode === 'manual' && tempo.sourceBpm === undefined
    ? { ...tempo, sourceBpm: (autoAnalysis.current ?? visualAnalysis.current)?.points[0]?.bpm }
    : tempo

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region h-14 shrink-0 flex items-center justify-between px-6">
        <h2 className="text-sm font-semibold truncate">{song.title}</h2>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-stretch gap-4 h-[220px]">
            {showVideo && (
              <div className="relative w-[391px] shrink-0">
                <div className="absolute -inset-4 bg-violet-500/10 blur-3xl rounded-full pointer-events-none" />
                <div className="absolute inset-0 rounded-xl overflow-hidden ring-1 ring-white/10 bg-black shadow-2xl shadow-black/60">
                  <div ref={containerRef} className="absolute inset-0 [&_iframe]:w-full [&_iframe]:h-full" />
                  {!ytReady && (
                    <div className="absolute inset-0 flex items-center justify-center animate-pulse">
                      <span className="text-[10px] text-white/40 tracking-widest uppercase">loading…</span>
                    </div>
                  )}
                  {decodeError && (
                    <div className="absolute inset-x-3 bottom-3 flex justify-center rise-in">
                      <div className="glass rounded-lg px-3 py-1.5 text-xs text-rose-300 break-words">
                        {decodeError}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <aside className="flex-1 min-w-0 glass rounded-2xl px-6 py-5 rise-in flex flex-col justify-between">
              <div className="flex items-center gap-4">
                <SongThumb
                  videoId={song.videoId}
                  className="w-32 h-[72px] rounded-lg object-cover bg-white/5 shrink-0 block"
                  iconClassName="w-7 h-7 text-white/25"
                />
                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-semibold leading-snug truncate">{song.title}</h3>
                  <p className="text-xs text-white/45 mt-1.5 font-mono truncate">
                    {fmtTime(song.duration)} · added {addedLabel}
                    {song.took ? ` · split in ${fmtTime(song.took)}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs px-3 py-1.5 rounded-full bg-white/5 text-white/50 font-medium">
                  {stemMeta.length} stems
                </span>
              </div>

              {!showVideo && decodeError && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-3 py-2 text-xs text-rose-200 break-words">
                  {decodeError}
                </div>
              )}

              <div className="flex items-center gap-x-6 gap-y-2 flex-wrap">
                {stemMeta.map((meta) => (
                  <span key={meta.id} className="flex items-center gap-2 text-[14px] text-white/75">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
                    <span className="capitalize">{meta.label}</span>
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={exportAllStems}
                  disabled={decoding || !!decodeError}
                  className="no-drag glass rounded-xl px-5 py-3 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 disabled:opacity-40"
                >
                  <DownloadIcon className="w-4 h-4" />
                  Export everything
                </button>
                {youtubeUrl && (
                  <button
                    onClick={() => window.stemkit.openExternal(youtubeUrl)}
                    className="no-drag glass rounded-xl px-5 py-3 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    Open on YouTube
                  </button>
                )}
              </div>
            </aside>
          </div>

          <Transport
            playing={playing}
            duration={duration}
            getPosition={getPosition}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            preset={preset === 'custom' ? 'all' : preset}
            onPreset={applyPreset}
            master={master}
            onMaster={setMaster}
            youtubeUrl={youtubeUrl ?? undefined}
            countIn={<CountInControls
              bars={countInBars}
              onBars={changeCountInBars}
              tempo={controlTempo}
              onTempo={changeTempo}
              detectedBpm={detectedBpm}
              detectingTempo={detectingTempo}
              error={countError ?? tempoSaveError}
              disabled={decoding || !!decodeError}
            />}
          />

          {panError && <p role="status" className="mt-3 text-xs text-amber-300">{panError}</p>}
          <div className="mt-4 space-y-2">
            {decoding
              ? [...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="glass rounded-xl h-16 animate-pulse"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))
              : stemMeta.map((meta) => (
              <StemLane
                key={meta.id}
                meta={meta}
                buffer={buffers[meta.id] ?? null}
                duration={duration}
                playing={playing}
                getPosition={getPosition}
                audible={!mutes.has(meta.id) && (solos.size === 0 || solos.has(meta.id))}
                volume={vols[meta.id] ?? 1}
                pan={pans[meta.id] ?? 0}
                onPan={(value) => changePan(meta.id, value)}
                muted={mutes.has(meta.id)}
                soloed={solos.has(meta.id)}
                onToggleMute={() => toggleMute(meta.id)}
                onToggleSolo={() => toggleSolo(meta.id)}
                onVolume={(v) => setVols((prev) => ({ ...prev, [meta.id]: v }))}
                onSeek={seekTo}
                onExport={() => exportStem(meta.id)}
              />
            ))}
            <MetronomeLane
              muted={!metronomeEnabled}
              soloed={solos.has('metronome')}
              audible={metronomeAudible}
              onToggleMute={() => toggleMute('metronome')}
              onToggleSolo={() => toggleSolo('metronome')}
              volume={clickVolume}
              onVolume={changeClickVolume}
              onVolumeCommit={saveClickVolume}
              onExport={() => exportStem('metronome')}
              pan={pans.metronome ?? 0}
              onPan={value => changePan('metronome', value)}
              peaks={metronomeWaveform}
              duration={duration}
              playing={playing}
              getPosition={getPosition}
              onSeek={seekTo}
              disabled={decoding || !!decodeError}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
