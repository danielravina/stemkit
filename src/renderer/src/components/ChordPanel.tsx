import { useEffect, useState, useCallback, useRef } from 'react'
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
  const [tick, setTick] = useState(0)
  const [sourcePref, setSourcePref] = useState<'auto' | 'local' | 'chordify'>('auto')
  const [countdownBeats, setCountdownBeats] = useState(false)

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

  // follow playback
  useEffect(() => {
    let raf = 0
    const loop = (): void => { setTick((n) => (n + 1) % 10000); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
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
  const displayDoc = activeDoc ? getDisplayDoc(activeDoc, transpose, capo) : null
  const soundingDoc = activeDoc ? getSoundingDoc(activeDoc, transpose) : null
  void tick
  const cur: ChordSegment | null = displayDoc ? activeChord(displayDoc, getPosition()) : null
  const upcoming = ((): ChordSegment[] => {
    if (!displayDoc) return []
    const t = getPosition()
    const idx = displayDoc.chords.findIndex((c) => t < c.time + c.duration)
    if (idx < 0) return []
    const start = cur ? idx + 1 : idx
    return displayDoc.chords.slice(start, start + 4)
  })()

  // ——— Chord-shift cue: detect when cur changes to pulse + keep prev for slide ———
  const prevChordRef = useRef<string | null>(null)
  const [pulseKey, setPulseKey] = useState(0)
  const [justChanged, setJustChanged] = useState(false)
  useEffect(() => {
    const curName = cur?.chord ?? null
    if (curName && prevChordRef.current && curName !== prevChordRef.current) {
      setPulseKey((k) => k + 1)
      setJustChanged(true)
      const t = window.setTimeout(() => setJustChanged(false), 620)
      return () => window.clearTimeout(t)
    }
    if (curName) prevChordRef.current = curName
  }, [cur?.chord])
  // on video switch reset
  useEffect(() => { prevChordRef.current = null; setJustChanged(false) }, [videoId])

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

  // countdown to next chord — live
  const nextChord = upcoming[0] ?? null
  const tNow = getPosition()
  const timeToNext = nextChord ? Math.max(0, nextChord.time - tNow) : null
  const nextProgress = cur ? Math.min(1, Math.max(0, (tNow - cur.time) / Math.max(0.2, cur.duration))) : 0
  const imminent = timeToNext !== null && timeToNext < 1.6
  const warning = timeToNext !== null && timeToNext < 3.0
  const bpm = activeDoc?.chordifyMeta?.bpm ?? null
  const beatsToNext = bpm && timeToNext !== null ? timeToNext / (60 / bpm) : null

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

      {/* big current + next — enlarged diagrams, exact Chordify copy for next */}
      {hasDoc && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[1.28fr_1fr] gap-4 items-stretch">
            {/* NOW — enlarged + chord-shift cues */}
            <div className={`rounded-xl border p-4 flex items-center gap-5 min-h-[168px] relative overflow-hidden transition-colors duration-300 ${justChanged ? 'bg-violet-500/15 border-violet-400/30' : imminent ? 'bg-amber-500/10 border-amber-400/25' : 'bg-black/30 border-white/10'}`}>
              {/* progress through current chord — fills as shift approaches, like Chordify's bar */}
              {cur && (
                <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-white/10">
                  <div className="h-full bg-violet-400 transition-none" style={{ width: `${nextProgress * 100}%`, opacity: justChanged ? 0.95 : 0.72 }} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] uppercase tracking-widest text-white/30">Now {sourceLabel ? `· ${sourceLabel}` : ''}{capo>0 ? ` · capo ${capo}` : ''}</span>
                  {justChanged && <span key={pulseKey} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500 text-white font-bold animate-pulse">shift!</span>}
                  {nextChord && !justChanged && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold border ${imminent ? 'bg-amber-400 text-black border-amber-300 animate-pulse' : warning ? 'bg-amber-500/20 text-amber-200 border-amber-400/30' : 'bg-white/10 text-white/50 border-white/10'}`}>
                      → {shapeLabel(nextChord.chord)} in {timeToNext !== null && timeToNext < 10 ? `${timeToNext.toFixed(1)}s` : fmtTime(nextChord.time)}
                      {countdownBeats && beatsToNext !== null ? ` · ${beatsToNext.toFixed(1)} beats` : ''}
                    </span>
                  )}
                </div>
                <div
                  key={cur ? cur.chord + String(pulseKey) : '—'}
                  className={`${justChanged ? 'animate-[pulse_0.55s_ease]' : ''} text-5xl font-extrabold tracking-tight truncate mt-1`}
                  style={{ color: cur ? chordColor(cur.chord) : 'rgba(255,255,255,0.5)' }}
                >
                  {cur ? shapeLabel(cur.chord) : '—'}
                </div>
                {cur && (
                  <div className="text-xs text-white/40 font-mono mt-1 flex items-center gap-2 flex-wrap">
                    <span>{fmtTime(cur.time)} · {cur.duration.toFixed(1)}s</span>
                    {cur.score < 0.55 && <span className="text-amber-300">low confidence</span>}
                    {activeDoc?.source === 'chordify' && <span className="text-emerald-300">chordify</span>}
                    {capo>0 && soundingDoc && (()=>{ const s = activeChord(soundingDoc, getPosition()); return s ? <span className="text-amber-200">sounding {displayLabel(s.chord, useFlats)}</span> : null })()}
                  </div>
                )}
                <div className="text-[11px] text-white/25 mt-2 hidden sm:flex items-center gap-2">
                  <span>Diagrams sync to master clock</span>
                  <span className="w-1 h-1 rounded-full bg-white/20" />
                  <label className="flex items-center gap-1 cursor-pointer no-drag">
                    <input type="checkbox" checked={countdownBeats} onChange={(e) => setCountdownBeats(e.target.checked)} className="w-3 h-3" />
                    <span className="text-white/40">beats</span>
                  </label>
                </div>
              </div>
              <div className={`shrink-0 transition-transform duration-300 ${justChanged ? 'scale-[1.03]' : 'scale-100'} ${imminent ? 'ring-2 ring-amber-400/30 rounded-xl' : ''}`}>
                {curVoicing ? (
                  <Fretboard voicing={curVoicing} capo={capo} width={212} height={148} />
                ) : (
                  <div className="w-[212px] h-[148px] rounded-xl bg-white/5 flex items-center justify-center text-white/20 text-xs">No diagram</div>
                )}
              </div>
            </div>

            {/* NEXT — exact Chordify copy: each next chord gets its own diagram, with imminent pulse */}
            <div className="rounded-xl bg-white/5 border border-white/10 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-widest text-white/30">Next — tap to jump</span>
                {nextChord && <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full ${imminent ? 'bg-amber-400 text-black animate-pulse' : 'bg-white/10 text-white/40'}`}>{timeToNext !== null ? `${timeToNext.toFixed(1)}s` : ''} → {shapeLabel(nextChord.chord)}</span>}
              </div>
              <div className="grid grid-cols-4 gap-2">
                {upcoming.length === 0 ? (
                  <span className="col-span-4 text-sm text-white/25 py-6 text-center">— end —</span>
                ) : (
                  upcoming.map((c, i) => {
                    const v = lookupVoicing(c.chord)
                    const isNext = i === 0
                    const isImminentCard = isNext && imminent
                    return (
                      <button
                        key={i}
                        onClick={() => onSeek(c.time + 0.02)}
                        className={`no-drag rounded-xl border flex flex-col items-center gap-1 py-2 px-1 transition-all ${isImminentCard ? 'bg-amber-400 border-amber-300 scale-[1.04] shadow-lg shadow-amber-500/20 animate-pulse' : isNext && warning ? 'bg-white border-white/20' : 'bg-black/40 border-white/10 hover:border-white/20 hover:bg-black/60'}`}
                      >
                        <span className={`text-[12px] font-extrabold leading-none truncate w-full text-center ${isImminentCard ? 'text-black' : ''}`} style={{ color: isImminentCard ? undefined : chordColor(c.chord) }}>{shapeLabel(c.chord)}</span>
                        <span className={`text-[10px] font-mono ${isImminentCard ? 'text-black/60' : 'text-white/35'}`}>{isNext && timeToNext !== null ? `in ${timeToNext.toFixed(1)}s` : fmtTime(c.time)}</span>
                        <div className="mt-1">
                          {v ? (
                            <Fretboard voicing={v} capo={capo} width={86} height={68} />
                          ) : (
                            <span className="text-[10px] text-white/20">—</span>
                          )}
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
              <div className="text-[11px] text-white/30 leading-snug">Left bar fills as the chord plays — <b className={imminent ? 'text-amber-300' : 'text-white/50'}>{nextChord ? `${shapeLabel(nextChord.chord)} in ${timeToNext !== null ? timeToNext.toFixed(1) : '—'}s` : 'end'}</b>. Next card pulses <span className="text-amber-300">amber</span> at 1.6s like Chordify · Tap to jump · Play to auto-follow</div>
            </div>
          </div>

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
