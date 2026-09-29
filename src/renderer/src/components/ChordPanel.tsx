import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { ChordsDoc, ChordSegment, ChordSources, ChordifyStatus } from '../../../shared/types'
import { lookupVoicing, chordColor, activeChord, getDisplayDoc, getSoundingDoc, detectKey, displayLabel } from '../lib/chords'
import { fmtTime } from '../lib/format'
import { ChordStrip } from './ChordStrip'
import { Fretboard } from './Fretboard'

interface Props {
  videoId: string
  duration: number
  getPosition: () => number
  onSeek: (t: number) => void
}

export function ChordPanel({ videoId, duration, getPosition, onSeek }: Props): React.ReactElement {
  const [sources, setSources] = useState<ChordSources | null>(null)
  const [cStatus, setCStatus] = useState<ChordifyStatus | null>(null)
  const [loading, setLoading] = useState<'local' | 'chordify' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [capo, setCapo] = useState(0)
  const [transpose, setTranspose] = useState(0)
  const [useFlats, setUseFlats] = useState(false)
  const [showList, setShowList] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'diagrams'>('diagrams')
  const [diagramMode, setDiagramMode] = useState<'animated' | 'summary'>('animated')
  const [tick, setTick] = useState(0)
  const [sourcePref, setSourcePref] = useState<'auto' | 'local' | 'chordify'>('auto')
  const timelineRef = useRef<HTMLDivElement>(null)
  const didScrollTimelineRef = useRef(false)
  const changeTimeoutRef = useRef<number | null>(null)
  const [justChanged, setJustChanged] = useState(false)
  const prevChordRef = useRef<string | null>(null)
  const trackedVideoIdRef = useRef(videoId)

  const load = useCallback((): void => {
    void window.stemkit.getChordSources(videoId).then(setSources)
    void window.stemkit.chordifyStatus().then(setCStatus).catch(() => setCStatus({ connected: false, cookieCount: 0 }))
  }, [videoId])

  useEffect(load, [load])
  useEffect(() => {
    const off = window.stemkit.onChordsDone((ev) => {
      if (ev.videoId === videoId) load()
    })
    const off2 = window.stemkit.onJobEvent((ev) => {
      if (ev.kind === 'failed' && (ev.data as { videoId: string }).videoId === videoId) {
        setLoading(null)
        setErr((ev.data as { message: string }).message)
      }
    })
    return () => { off(); off2() }
  }, [videoId, load])

  // Refresh the time-synced chord view often enough for a smooth playhead/countdown
  // without forcing a full React render on every animation frame.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => (n + 1) % 10000), 100)
    return () => window.clearInterval(timer)
  }, [])

  const analyzeLocal = async (): Promise<void> => {
    setLoading('local'); setErr(null)
    try {
      const r = await window.stemkit.analyzeChords(videoId)
      if (!r.started) { setErr(r.error ?? 'Failed to start'); setLoading(null) }
      else {
        const t = setInterval(async () => {
          const s = await window.stemkit.getChordSources(videoId)
          if (s.local) { setSources(s); setLoading(null); clearInterval(t) }
        }, 1200)
        setTimeout(() => { clearInterval(t); setLoading(null); load() }, 30000)
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setLoading(null) }
  }

  // de-dupe: don't re-popup the same auto-open within 45s
  const lastAutoOpen = useRef(0)
  const fetchChordify = async (): Promise<void> => {
    setLoading('chordify'); setErr(null)
    try {
      const r = await window.stemkit.chordifyFetch(videoId)
      if (!r.ok) {
        const msg = r.error ?? 'Chordify fetch failed'
        const needsTrigger = /not analysed|not analysed|chordify\.net\/chords\/youtube/i.test(msg)
        if (needsTrigger && Date.now() - lastAutoOpen.current > 45000) {
          lastAutoOpen.current = Date.now()
          try { await window.stemkit.chordifyOpen(videoId) } catch {}
        }
        setErr(msg)
      } else load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setLoading(null)
  }

  const importChordify = async (): Promise<void> => {
    setLoading('chordify'); setErr(null)
    try {
      const r = await window.stemkit.chordifyImport(videoId)
      if (!r.ok && !/cancelled/i.test(r.error ?? '')) setErr(r.error ?? 'Import failed')
      if (r.ok) load()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setLoading(null)
  }

  const connect = async (): Promise<void> => {
    setErr(null)
    try {
      await window.stemkit.chordifyLogin()
      const s = await window.stemkit.chordifyStatus()
      setCStatus(s)
      if (!s.connected) setErr('Not connected yet — log in to chordify.net in the window that opened, then close it and try Fetch again.')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  // pick active doc (original, concert pitch)
  const activeDoc: ChordsDoc | null = (() => {
    if (!sources) return null
    if (sourcePref === 'local') return sources.local
    if (sourcePref === 'chordify') return sources.chordify
    return sources.chordify ?? sources.local ?? null
  })()

  // display doc: sounding = doc + transpose, shape = sounding - capo
  const displayDoc = useMemo(
    () => activeDoc ? getDisplayDoc(activeDoc, transpose, capo) : null,
    [activeDoc, transpose, capo]
  )
  const soundingDoc = useMemo(
    () => activeDoc ? getSoundingDoc(activeDoc, transpose) : null,
    [activeDoc, transpose]
  )
  void tick
  const cur: ChordSegment | null = displayDoc ? activeChord(displayDoc, getPosition()) : null
  const progression = displayDoc?.chords.filter((chord) => chord.chord !== 'N') ?? []
  const curIndex = cur
    ? progression.findIndex((chord) => chord.time === cur.time && chord.chord === cur.chord)
    : -1
  const currentKey = cur ? `${cur.time}:${cur.chord}` : null
  const summaryChords = progression.filter(
    (chord, index) => progression.findIndex((candidate) => candidate.chord === chord.chord) === index
  )
  const tNow = getPosition()
  const gridDuration = duration > 0 ? duration : activeDoc?.duration ?? 0
  const chordifyBpm = activeDoc?.chordifyMeta?.bpm
  const gridBpm = chordifyBpm && Number.isFinite(chordifyBpm) && chordifyBpm > 0 ? chordifyBpm : 120
  const gridTempoEstimated = !(chordifyBpm && Number.isFinite(chordifyBpm) && chordifyBpm > 0)
  const beatsPerBar = Math.min(12, Math.max(1, Math.round(activeDoc?.chordifyMeta?.barLength || 4)))
  const beatDuration = 60 / gridBpm
  const gridBeats = useMemo(() => {
    if (!displayDoc || gridDuration <= 0) return []
    const cells: { index: number; time: number; measureIndex: number; beatIndex: number; chord: string | null; label: string | null }[] = []
    const beatCount = Math.ceil(gridDuration / beatDuration)
    let chordIndex = 0
    let soundingChord: string | null = null
    let lastLabeledChord: string | null = null

    for (let index = 0; index < beatCount; index += 1) {
      const time = index * beatDuration
      while (chordIndex < displayDoc.chords.length && displayDoc.chords[chordIndex].time + displayDoc.chords[chordIndex].duration <= time) {
        chordIndex += 1
      }
      const segment = displayDoc.chords[chordIndex]
      if (segment && segment.time <= time && segment.chord !== 'N') soundingChord = segment.chord
      const changed = soundingChord !== null && soundingChord !== lastLabeledChord
      cells.push({
        index,
        time,
        measureIndex: Math.floor(index / beatsPerBar),
        beatIndex: index % beatsPerBar,
        chord: soundingChord,
        label: changed ? soundingChord : null
      })
      if (changed) lastLabeledChord = soundingChord
    }
    return cells
  }, [displayDoc, gridDuration, beatDuration, beatsPerBar])
  const gridMeasures = useMemo(() => {
    const measureCount = Math.ceil(gridBeats.length / beatsPerBar)
    return Array.from({ length: measureCount }, (_, measureIndex) => ({
      index: measureIndex,
      beats: gridBeats.slice(measureIndex * beatsPerBar, (measureIndex + 1) * beatsPerBar)
    }))
  }, [gridBeats, beatsPerBar])
  const currentBeatIndex = gridBeats.length > 0
    ? Math.min(gridBeats.length - 1, Math.max(0, Math.floor(tNow / beatDuration)))
    : -1
  const currentMeasureIndex = currentBeatIndex >= 0 ? Math.floor(currentBeatIndex / beatsPerBar) : -1

  // Chordify's animated diagram view follows the current segment, not just its
  // chord name, so repeated chords still trigger a smooth change/scroll.
  useEffect(() => {
    if (trackedVideoIdRef.current !== videoId) {
      trackedVideoIdRef.current = videoId
      prevChordRef.current = currentKey
      didScrollTimelineRef.current = false
      setJustChanged(false)
      return
    }
    if (currentKey && prevChordRef.current && currentKey !== prevChordRef.current) {
      setJustChanged(true)
      if (changeTimeoutRef.current !== null) window.clearTimeout(changeTimeoutRef.current)
      changeTimeoutRef.current = window.setTimeout(() => {
        setJustChanged(false)
        changeTimeoutRef.current = null
      }, 360)
    }
    prevChordRef.current = currentKey
  }, [videoId, currentKey])

  useEffect(() => () => {
    if (changeTimeoutRef.current !== null) window.clearTimeout(changeTimeoutRef.current)
  }, [])

  useEffect(() => {
    if (viewMode === 'grid') {
      if (currentMeasureIndex < 0) return
      const timeline = timelineRef.current
      const measure = timeline?.querySelector<HTMLElement>(`[data-measure-index="${currentMeasureIndex}"]`)
      if (!timeline || !measure) return
      const timelineRect = timeline.getBoundingClientRect()
      const measureRect = measure.getBoundingClientRect()
      const left = timeline.scrollLeft + measureRect.left - timelineRect.left - (timeline.clientWidth - measureRect.width) / 2
      timeline.scrollTo({ left, behavior: didScrollTimelineRef.current ? 'smooth' : 'auto' })
      didScrollTimelineRef.current = true
      return
    }
    if (diagramMode !== 'animated' || curIndex < 0) return
    const timeline = timelineRef.current
    const card = timeline?.querySelector<HTMLElement>(`[data-chord-index="${curIndex}"]`)
    if (!timeline || !card) return
    const timelineRect = timeline.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const left = timeline.scrollLeft + cardRect.left - timelineRect.left - (timeline.clientWidth - cardRect.width) / 2
    timeline.scrollTo({ left, behavior: didScrollTimelineRef.current ? 'smooth' : 'auto' })
    didScrollTimelineRef.current = true
  }, [viewMode, diagramMode, currentKey, curIndex, currentMeasureIndex])

  const curVoicing = ((): ReturnType<typeof lookupVoicing> => {
    if (!cur) return null
    return lookupVoicing(cur.chord)
  })()

  const hasLocal = !!sources?.local
  const hasChordify = !!sources?.chordify
  const hasDoc = !!activeDoc && activeDoc.chords.length > 0
  const activeSource = sources?.active ?? null

  const effectiveKey = ((): string | null => {
    if (!soundingDoc) return null
    const k = detectKey(soundingDoc)
    if (!k) return null
    return useFlats ? displayLabel(k.nameSharp, true) : k.nameSharp
  })()
  const effectiveKeyShape = ((): string | null => {
    if (!displayDoc) return null
    const k = detectKey(displayDoc)
    if (!k) return null
    return displayLabel(k.nameSharp, useFlats)
  })()

  function shapeLabel(s: string): string {
    return displayLabel(s, useFlats)
  }

  // Live next-chord timing and current segment progress.
  const nextChord = curIndex >= 0
    ? progression[curIndex + 1] ?? null
    : progression.find((chord) => chord.time > tNow) ?? null
  const timeToNext = nextChord ? Math.max(0, nextChord.time - tNow) : null
  const nextProgress = cur ? Math.min(1, Math.max(0, (tNow - cur.time) / Math.max(0.2, cur.duration))) : 0
  const imminent = timeToNext !== null && timeToNext < 1.6

  const chordifyConnected = !!cStatus?.connected
  const sourceLabel = activeDoc?.source === 'chordify' ? 'Chordify' : activeDoc?.source === 'local' ? 'Local' : null

  return (
    <section className="glass rounded-2xl px-5 py-4 flex flex-col gap-4">
      {/* header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">Guitar — Chordify</span>
          {hasDoc && effectiveKey && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-white/45" title={capo>0 ? `Sounding key; shape key ${effectiveKeyShape} at capo ${capo}` : undefined}>Key {effectiveKey}{capo>0 && effectiveKeyShape!==effectiveKey ? ` · shape ${effectiveKeyShape}` : ''}</span>
          )}
          {hasDoc && (
            <span className="text-[11px] text-white/25 font-mono">{activeDoc!.chords.length} chords · {fmtTime(activeDoc!.duration)}</span>
          )}
          {hasDoc && sourceLabel && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${sourceLabel === 'Chordify' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/20' : 'bg-white/5 text-white/40 border border-white/10'}`}>
              {sourceLabel === 'Chordify' ? '✓ Chordify' : 'Offline'} {activeDoc?.chordifyMeta ? `· ${activeDoc.chordifyMeta.bpm} BPM` : ''}
            </span>
          )}
          {hasLocal && hasChordify && (
            <span className="text-[11px] text-white/20">· local + chordify cached</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {!hasDoc ? (
            <>
              <button
                onClick={analyzeLocal}
                disabled={loading !== null}
                className="no-drag px-3.5 py-1.5 rounded-full bg-white text-black text-[13px] font-semibold hover:bg-white/90 disabled:opacity-50"
              >
                {loading === 'local' ? 'Analyzing…' : 'Analyze offline'}
              </button>
              {chordifyConnected ? (
                <button
                  onClick={fetchChordify}
                  disabled={loading !== null}
                  className="no-drag px-3.5 py-1.5 rounded-full bg-emerald-500 text-white text-[13px] font-semibold hover:bg-emerald-400 disabled:opacity-50"
                >
                  {loading === 'chordify' ? 'Fetching…' : 'Fetch from Chordify'}
                </button>
              ) : (
                <button
                  onClick={connect}
                  className="no-drag px-3.5 py-1.5 rounded-full bg-violet-500 text-white text-[13px] font-semibold hover:bg-violet-400"
                >
                  Connect Chordify
                </button>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-1 bg-black/20 rounded-full p-0.5 border border-white/10">
                <button onClick={() => setSourcePref('auto')} className={`no-drag px-2.5 py-1 rounded-full text-[11px] font-medium ${sourcePref === 'auto' ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}>Auto{activeSource ? ` ·${activeSource}` : ''}</button>
                {hasLocal && <button onClick={() => setSourcePref('local')} className={`no-drag px-2.5 py-1 rounded-full text-[11px] ${sourcePref === 'local' ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}>Local {sources?.local ? `·${sources.local.chords.length}` : ''}</button>}
                {hasChordify && <button onClick={() => setSourcePref('chordify')} className={`no-drag px-2.5 py-1 rounded-full text-[11px] ${sourcePref === 'chordify' ? 'bg-emerald-500 text-white' : 'text-white/50 hover:text-white'}`}>Chordify {sources?.chordify ? `·${sources.chordify.chords.length}` : ''}</button>}
              </div>
              <button onClick={analyzeLocal} disabled={loading !== null} className="no-drag px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[11px] text-white/60">{loading === 'local' ? '…' : 'Re-analyze'}</button>
              {chordifyConnected ? (
                <button onClick={fetchChordify} disabled={loading !== null} className="no-drag px-2.5 py-1 rounded-full bg-emerald-500/20 hover:bg-emerald-500/30 text-[11px] text-emerald-200 border border-emerald-400/20">{loading === 'chordify' ? '…' : 'Re-fetch'}</button>
              ) : (
                <button onClick={connect} className="no-drag px-2.5 py-1 rounded-full bg-violet-500/20 hover:bg-violet-500/30 text-[11px] text-violet-200 border border-violet-400/20">Connect</button>
              )}
              <button onClick={() => void window.stemkit.exportChords(videoId)} className="no-drag px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[11px] text-white/60">Export</button>
              <button onClick={() => setShowList((s) => !s)} className={`no-drag px-2.5 py-1 rounded-full text-[11px] ${showList ? 'bg-white text-black' : 'bg-white/5 text-white/60'}`}>{showList ? 'Hide list' : 'List'}</button>
            </>
          )}
        </div>
      </div>

      {hasDoc && !chordifyConnected && (
        <div className="rounded-xl bg-violet-500/10 border border-violet-400/20 px-3 py-2.5 flex items-center justify-between gap-3">
          <p className="text-xs text-violet-200 leading-relaxed">
            Showing <b>offline chords</b> ({hasDoc ? activeDoc!.chords.length : 0} segments) — simpler triads now, tough extensions removed. Your Chordify subscription gives hand-checked guitar chords: connect to replace with premium chords for this song.
          </p>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={connect} className="no-drag px-3 py-1 rounded-full bg-violet-500 text-white text-xs font-semibold hover:bg-violet-400">Log in to Chordify</button>
            <button onClick={importChordify} className="no-drag px-2.5 py-1 rounded-full bg-white/10 text-white/70 text-xs">Import file</button>
          </div>
        </div>
      )}
      {hasDoc && chordifyConnected && !hasChordify && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-400/20 px-3 py-2.5 flex items-center justify-between gap-3">
          <p className="text-xs text-emerald-100">Connected to Chordify — fetch replaces the offline chords with premium guitar-friendly ones.</p>
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={fetchChordify} disabled={loading !== null} className="no-drag px-3 py-1 rounded-full bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-400 disabled:opacity-50">Fetch for this song</button>
            <button onClick={importChordify} className="no-drag px-2.5 py-1 rounded-full bg-white/10 text-white/70 text-xs">Import</button>
          </div>
        </div>
      )}
      {hasDoc && hasChordify && (
        <div className="rounded-xl bg-black/20 border border-white/10 px-3 py-2 flex items-center justify-between gap-2">
          <span className="text-xs text-white/60">
            <span className="text-emerald-300 font-semibold">Chordify premium active</span> — curated beats with simple guitar triads (compare to Local offline in the toggle above).
            {activeDoc?.chordifyMeta ? ` · ${activeDoc.chordifyMeta.bpm} BPM · ${activeDoc.chordifyMeta.barLength}/4` : ''}
          </span>
          <button
            onClick={async () => { await window.stemkit.chordifyDelete(videoId); load(); setSourcePref('local') }}
            className="no-drag text-xs text-white/40 hover:text-white underline shrink-0"
          >
            Remove Chordify
          </button>
        </div>
      )}

      {err && (
        <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-3 py-2 flex items-start justify-between gap-3">
          <p className="text-xs text-rose-200 whitespace-pre-wrap break-words flex-1">{err}</p>
          <div className="flex items-center gap-1.5 shrink-0">
            {err.includes('chordify.net/chords/youtube') && (
              <button onClick={() => void window.stemkit.chordifyOpen(videoId)} className="no-drag px-3 py-1 rounded-full bg-violet-500 text-white text-xs font-semibold hover:bg-violet-400">Open in Chordify</button>
            )}
            <button onClick={() => setErr(null)} className="no-drag w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white/60 text-xs">✕</button>
          </div>
        </div>
      )}
      {loading && <div className="text-xs text-violet-300 flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin" /> {loading === 'chordify' ? 'Contacting chordify.net…' : 'Analyzing… ~2–5s'}</div>}

      {/* controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 bg-white/5 rounded-full p-1">
          <span className="text-[11px] text-white/40 px-2">Transpose</span>
          <button onClick={() => setTranspose((t) => Math.max(-6, t - 1))} className="no-drag w-6 h-6 rounded-full bg-white/10 hover:bg-white/15 text-white">−</button>
          <span className="w-8 text-center text-sm font-mono">{transpose > 0 ? `+${transpose}` : transpose}</span>
          <button onClick={() => setTranspose((t) => Math.min(6, t + 1))} className="no-drag w-6 h-6 rounded-full bg-white/10 hover:bg-white/15 text-white">+</button>
          <button onClick={() => setTranspose(0)} className="no-drag ml-1 px-2 py-1 rounded-full bg-white text-black text-[11px] font-semibold">Reset</button>
        </div>
        <div className="flex items-center gap-1 bg-white/5 rounded-full p-1">
          <span className="text-[11px] text-white/40 px-2">Capo</span>
          <button onClick={() => setCapo((c) => Math.max(0, c - 1))} className="no-drag w-6 h-6 rounded-full bg-white/10 hover:bg-white/15 text-white">−</button>
          <span className="w-6 text-center text-sm font-mono">{capo}</span>
          <button onClick={() => setCapo((c) => Math.min(7, c + 1))} className="no-drag w-6 h-6 rounded-full bg-white/10 hover:bg-white/15 text-white">+</button>
        </div>
        <label className="no-drag flex items-center gap-1.5 text-xs text-white/45 cursor-pointer">
          <input type="checkbox" checked={useFlats} onChange={(e) => setUseFlats(e.target.checked)} /> ♭ flats
        </label>
        {capo > 0 && <span className="text-[11px] text-amber-200 bg-amber-500/15 border border-amber-400/20 rounded-full px-2 py-0.5">Capo {capo} · shapes transpose −{capo}</span>}
        {!chordifyConnected && (
          <button onClick={importChordify} className="no-drag ml-auto text-xs text-white/30 hover:text-white/60 underline">Import Chordify JSON</button>
        )}
      </div>

      {/* Chordify-style chord diagrams: animated playback follows the active chord;
          summary shows the unique voicings used in this song. */}
      {hasDoc && (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-white/35">Chord view</span>
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/25 p-1" role="tablist" aria-label="Chord view">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'grid'}
                onClick={() => { setViewMode('grid'); didScrollTimelineRef.current = false }}
                className={`no-drag rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'grid' ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}
              >
                Grid
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'diagrams'}
                onClick={() => { setViewMode('diagrams'); didScrollTimelineRef.current = false }}
                className={`no-drag rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${viewMode === 'diagrams' ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}
              >
                Diagrams
              </button>
            </div>
          </div>

          {viewMode === 'grid' ? (
            <div className="rounded-2xl border border-white/10 bg-[#111116] p-3 sm:p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white/85">Beat grid</div>
                  <div className="mt-0.5 text-[11px] text-white/35">One square per beat · chord names appear when they change</div>
                </div>
                <span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-mono text-white/50">
                  {beatsPerBar}/4 · {gridBpm} BPM{gridTempoEstimated ? ' · estimated' : ''}
                </span>
              </div>
              {gridMeasures.length > 0 ? (
                <div ref={timelineRef} className="chordify-timeline flex gap-2 overflow-x-auto pb-2" aria-label="Chord beat grid">
                  {gridMeasures.map((measure) => (
                    <div
                      key={measure.index}
                      data-measure-index={measure.index}
                      className={`flex shrink-0 flex-col gap-2 rounded-xl border p-2 transition-colors ${measure.index === currentMeasureIndex ? 'border-white/25 bg-white/[0.045]' : 'border-white/[0.08] bg-black/15'}`}
                    >
                      <div className="flex items-center justify-between gap-4 px-1">
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">Bar {measure.index + 1}</span>
                        <span className="text-[10px] font-mono text-white/30">{fmtTime(measure.beats[0]?.time ?? 0)}</span>
                      </div>
                      <div className="flex gap-1.5" role="group" aria-label={`Bar ${measure.index + 1}`}>
                        {measure.beats.map((beat) => {
                          const isCurrentBeat = beat.index === currentBeatIndex
                          const chord = beat.chord
                          return (
                            <button
                              key={beat.index}
                              type="button"
                              onClick={() => onSeek(beat.time)}
                              title={`${chord ? `${shapeLabel(chord)} · ` : ''}${fmtTime(beat.time)} · beat ${beat.beatIndex + 1}`}
                              aria-label={`Bar ${measure.index + 1}, beat ${beat.beatIndex + 1}${beat.label ? `, ${shapeLabel(beat.label)} chord change` : chord ? `, ${shapeLabel(chord)} continues` : ', no chord detected'}${isCurrentBeat ? ', current beat' : ''}`}
                              aria-current={isCurrentBeat ? 'time' : undefined}
                              className={`no-drag relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border text-center transition-[transform,box-shadow,background-color] duration-150 sm:h-14 sm:w-14 ${isCurrentBeat ? 'z-10 scale-105 border-white/90 bg-[#09090c] text-white shadow-[0_0_0_2px_rgba(255,255,255,.18)]' : chord ? 'border-black/20 text-black hover:brightness-110' : 'border-white/10 bg-white/[0.04] text-white/35 hover:bg-white/[0.08]'}`}
                              style={!isCurrentBeat && chord ? { backgroundColor: chordColor(chord), opacity: 0.72 } : undefined}
                            >
                              <span className="absolute left-1 top-0.5 text-[9px] font-mono opacity-55">{beat.beatIndex + 1}</span>
                              {beat.label && <span className="max-w-full truncate px-1 pt-2 text-[11px] font-bold">{shapeLabel(beat.label)}</span>}
                              {chord && !beat.label && <span className="pt-2 text-[10px] font-semibold opacity-35">·</span>}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-white/35">Beat grid unavailable for this song.</div>
              )}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-white/35">
                <span>Dark square = current beat · blank beat keeps the previous chord sounding</span>
                {gridTempoEstimated && <span>Offline analysis has no tempo data; grid uses an approximate 120 BPM.</span>}
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-end">
                <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/25 p-1" role="tablist" aria-label="Diagram layout">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={diagramMode === 'animated'}
                    onClick={() => setDiagramMode('animated')}
                    className={`no-drag rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${diagramMode === 'animated' ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}
                  >
                    Animated
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={diagramMode === 'summary'}
                    onClick={() => setDiagramMode('summary')}
                    className={`no-drag rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${diagramMode === 'summary' ? 'bg-white text-black' : 'text-white/50 hover:text-white'}`}
                  >
                    Summary
                  </button>
                </div>
              </div>

              {diagramMode === 'animated' ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 lg:grid-cols-[1.08fr_.92fr] gap-3 items-stretch">
                <div className={`relative overflow-hidden rounded-2xl border bg-[#111116] p-4 sm:p-5 transition-colors duration-300 ${justChanged ? 'border-white/25' : 'border-white/10'}`}>
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-white/5">
                    <div className="h-full bg-violet-400/80" style={{ width: `${nextProgress * 100}%` }} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">Current chord</span>
                    <span className="text-xs font-mono text-white/35">{cur ? fmtTime(tNow) : '—'}{sourceLabel ? ` · ${sourceLabel}` : ''}</span>
                  </div>
                  {cur ? (
                    <div key={currentKey} className={`mt-2 flex min-h-[190px] items-center justify-between gap-4 ${justChanged ? 'chordify-change-in' : ''}`}>
                      <div className="min-w-0">
                        <div className="truncate text-5xl sm:text-6xl font-bold tracking-tight" style={{ color: chordColor(cur.chord) }}>
                          {shapeLabel(cur.chord)}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono text-white/45">
                          <span>{fmtTime(cur.time)} · {cur.duration.toFixed(1)}s</span>
                          {cur.score < 0.55 && <span className="text-amber-300">low confidence</span>}
                          {capo > 0 && soundingDoc && (() => {
                            const sounding = activeChord(soundingDoc, tNow)
                            return sounding ? <span className="text-amber-200">sounding {displayLabel(sounding.chord, useFlats)}</span> : null
                          })()}
                        </div>
                      </div>
                      <div className="shrink-0">
                        {curVoicing ? <Fretboard voicing={curVoicing} capo={capo} width={236} height={174} /> : (
                          <div className="flex h-[174px] w-[236px] items-center justify-center text-sm text-white/25">No diagram</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-[190px] items-center justify-center text-sm text-white/35">No chord at this time</div>
                  )}
                </div>

                <div className="rounded-2xl border border-white/10 bg-[#111116] p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">Next chord</span>
                    {timeToNext !== null && <span className={`rounded-full px-2.5 py-1 text-xs font-mono ${imminent ? 'bg-white text-black' : 'bg-white/5 text-white/50'}`}>in {timeToNext.toFixed(1)}s</span>}
                  </div>
                  {nextChord ? (
                    <div key={`${nextChord.time}:${nextChord.chord}`} className={`mt-2 flex min-h-[190px] items-center justify-between gap-4 ${justChanged ? 'chordify-next-in' : ''}`}>
                      <div className="min-w-0">
                        <div className="truncate text-4xl sm:text-5xl font-bold tracking-tight" style={{ color: chordColor(nextChord.chord) }}>
                          {shapeLabel(nextChord.chord)}
                        </div>
                        <div className="mt-2 text-xs font-mono text-white/40">starts {fmtTime(nextChord.time)}</div>
                      </div>
                      {lookupVoicing(nextChord.chord) ? (
                        <Fretboard voicing={lookupVoicing(nextChord.chord)!} capo={capo} width={210} height={158} />
                      ) : (
                        <div className="flex h-[158px] w-[210px] items-center justify-center text-sm text-white/25">No diagram</div>
                      )}
                    </div>
                  ) : (
                    <div className="flex min-h-[190px] items-center justify-center text-sm text-white/35">End of song</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#111116] p-3 sm:p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/40">Progression · follows playback</span>
                  <span className="text-[11px] text-white/30">Select a chord to jump</span>
                </div>
                <div ref={timelineRef} className="chordify-timeline flex gap-2 overflow-x-auto pb-2" aria-label="Chord progression">
                  {progression.map((chord, index) => {
                    const isCurrent = index === curIndex
                    const isNext = index === curIndex + 1
                    const fill = isCurrent ? nextProgress * 100 : isNext ? 0 : 100
                    const cardWidth = Math.max(92, Math.min(170, chord.duration * 38))
                    return (
                      <button
                        key={`${chord.time}:${chord.chord}`}
                        type="button"
                        data-chord-index={index}
                        aria-current={isCurrent ? 'time' : undefined}
                        aria-label={`${shapeLabel(chord.chord)} at ${fmtTime(chord.time)}${isCurrent ? ', current chord' : ''}`}
                        onClick={() => onSeek(chord.time + 0.02)}
                        style={{ width: `${cardWidth}px` }}
                        className={`no-drag relative flex shrink-0 flex-col items-center justify-center rounded-xl border px-3 py-3 text-left transition-[background-color,border-color,transform] duration-200 ${isCurrent ? 'scale-[1.02] border-white/70 bg-white text-[#17171b] shadow-lg shadow-black/25' : isNext ? 'border-white/20 bg-white/[0.07] text-white hover:bg-white/10' : 'border-white/[0.08] bg-black/20 text-white/75 hover:border-white/20 hover:bg-white/[0.06]'}`}
                      >
                        <span className={`w-full text-center text-[10px] font-mono ${isCurrent ? 'text-black/45' : 'text-white/35'}`}>{fmtTime(chord.time)}</span>
                        <span className="mt-1 w-full truncate text-center text-lg font-bold" style={{ color: isCurrent ? undefined : chordColor(chord.chord) }}>{shapeLabel(chord.chord)}</span>
                        <span className={`mt-1 w-full text-center text-[10px] font-mono ${isCurrent ? 'text-black/45' : 'text-white/35'}`}>{chord.duration.toFixed(1)}s</span>
                        <div className={`mt-2 h-1 w-full overflow-hidden rounded-full ${isCurrent ? 'bg-black/10' : 'bg-white/10'}`}>
                          <div className={`h-full ${isCurrent ? 'bg-black/50' : 'bg-white/50'}`} style={{ width: `${fill}%` }} />
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {summaryChords.map((chord) => {
                const voicing = lookupVoicing(chord.chord)
                const isCurrent = cur?.chord === chord.chord
                return (
                  <button
                    key={chord.chord}
                    type="button"
                    aria-label={`Jump to ${shapeLabel(chord.chord)}`}
                    onClick={() => onSeek(chord.time + 0.02)}
                    className={`no-drag flex flex-col items-center rounded-xl border p-3 transition-colors ${isCurrent ? 'border-white/60 bg-white text-black' : 'border-white/10 bg-[#111116] hover:border-white/25 hover:bg-white/[0.06]'}`}
                  >
                    <span className="text-lg font-bold" style={{ color: isCurrent ? undefined : chordColor(chord.chord) }}>{shapeLabel(chord.chord)}</span>
                    {voicing ? <Fretboard voicing={voicing} capo={capo} width={150} height={120} /> : <span className="py-8 text-xs text-white/25">No diagram</span>}
                    <span className={`mt-1 text-[10px] font-mono ${isCurrent ? 'text-black/50' : 'text-white/35'}`}>first at {fmtTime(chord.time)}</span>
                  </button>
                )
                  })}
                </div>
              )}
            </>
          )}

          <ChordStrip doc={displayDoc} duration={duration} getPosition={getPosition} onSeek={onSeek} />

          {showList && (
            <div className="rounded-xl bg-black/20 border border-white/10 max-h-[220px] overflow-auto divide-y divide-white/5">
              <div className="sticky top-0 bg-black/40 backdrop-blur px-3 py-1.5 text-[11px] uppercase tracking-widest text-white/30 flex gap-2">
                <span className="w-16">Time</span><span>Chord</span>{capo>0 && <span className="text-amber-200">· sounding</span>}<span className="ml-auto">Dur</span>
              </div>
              {displayDoc!.chords.map((c, i) => {
                const isActive = !!(cur && c.time === cur.time && c.chord === cur.chord)
                const sounding = soundingDoc ? soundingDoc.chords[i] : null
                return (
                  <button
                    key={i}
                    onClick={() => onSeek(c.time + 0.02)}
                    className={`no-drag w-full text-left px-3 py-1.5 flex gap-2 text-sm font-mono hover:bg-white/5 ${isActive ? 'bg-violet-500/20 text-white' : c.chord === 'N' ? 'text-white/30' : 'text-white/80'}`}
                  >
                    <span className="w-16">{fmtTime(c.time)}</span>
                    <span className="font-semibold" style={{ color: isActive ? undefined : chordColor(c.chord) }}>{shapeLabel(c.chord)}</span>
                    {capo>0 && sounding && sounding.chord!==c.chord && <span className="text-amber-200/60 text-xs">{displayLabel(sounding.chord, useFlats)}</span>}
                    <span className="ml-auto text-white/35">{c.duration.toFixed(1)}s</span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {!hasDoc && !loading && !err && (
        <div className="space-y-3">
          <p className="text-xs text-white/30 leading-relaxed">
            Offline analysis runs on <code className="bg-white/10 px-1 rounded">mix.wav</code> — ~2s, no network. Now guitar-friendly (plain triads; extensions only when the 7th is really there). Your Chordify subscription gives cleaner, beat-aligned chords — connect below and Fetch will pull them for this song.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={connect} className="no-drag px-3 py-1.5 rounded-full bg-violet-500 text-white text-xs font-semibold hover:bg-violet-400">Connect Chordify</button>
            <button onClick={importChordify} className="no-drag px-3 py-1.5 rounded-full bg-white/10 text-white/70 text-xs">Import Chordify JSON</button>
            <span className="text-xs text-white/25">or paste a chordify.net export — works offline after import</span>
          </div>
        </div>
      )}
    </section>
  )
}
