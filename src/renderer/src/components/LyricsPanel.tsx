import { useCallback, useEffect, useRef, useState } from 'react'
import type { LyricsDoc, LyricLine } from '../../../shared/types'
import { fmtTime } from '../lib/format'

interface Props {
  videoId: string
  duration: number
  getPosition: () => number
  onSeek: (t: number) => void
}

function activeIdx(lines: LyricLine[], t: number): number {
  // current line: last line whose time <= t < time+duration (with tiny linger)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (t >= l.time - 0.08 && t < l.time + l.duration + 0.25) return i
  }
  // before first word — nothing active
  if (lines.length && t < lines[0].time) return -1
  // past end — stay on last
  if (lines.length && t >= lines[lines.length - 1].time) return lines.length - 1
  return -1
}

export function LyricsPanel({ videoId, duration, getPosition, onSeek }: Props): React.ReactElement {
  const [doc, setDoc] = useState<LyricsDoc | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  const load = useCallback(() => {
    void window.stemkit.getLyrics(videoId).then(setDoc).catch(() => setDoc(null))
  }, [videoId])

  useEffect(load, [load])
  useEffect(() => {
    const off = (window.stemkit as unknown as { onLyricsDone: (cb: (ev: { videoId: string }) => void) => () => void }).onLyricsDone?.((ev) => {
      if (ev.videoId === videoId) load()
    })
    return () => { off?.() }
  }, [videoId, load])

  // follow playback — rAF tick so karaoke highlight moves with master clock
  useEffect(() => {
    let raf = 0
    const loop = (): void => { setTick((n) => (n + 1) % 10000); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const curI = doc ? activeIdx(doc.lines, getPosition()) : -1
  void tick
  void duration

  // karaoke autoscroll — keep active line centered like Chordify's follow
  useEffect(() => {
    if (!autoScroll || curI < 0) return
    const el = rowRefs.current.get(curI)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [curI, autoScroll])

  const fetchYt = async (): Promise<void> => {
    setLoading(true); setErr(null)
    try {
      const r = await window.stemkit.fetchLyrics(videoId)
      if (!r.ok) setErr(r.error ?? 'Failed to fetch captions')
      else setDoc(r.doc ?? null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setLoading(false)
  }

  const importFile = async (): Promise<void> => {
    setLoading(true); setErr(null)
    try {
      const r = await window.stemkit.importLyrics(videoId)
      if (!r.ok && !/cancelled/i.test(r.error ?? '')) setErr(r.error ?? 'Import failed')
      else if (r.ok) setDoc(r.doc ?? null)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setLoading(false)
  }

  const handleManualSeek = (line: LyricLine): void => {
    // let user know they're jumping; pause autoscroll for a beat
    setAutoScroll(false)
    onSeek(line.time + 0.02)
    window.setTimeout(() => setAutoScroll(true), 2500)
  }

  const hasDoc = !!doc && doc.lines.length > 0

  return (
    <section className="glass rounded-2xl px-5 py-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">Lyrics</span>
          {hasDoc && <span className="text-[11px] text-white/25 font-mono">{doc!.lines.length} lines · {doc!.source === 'youtube' ? 'YouTube captions' : 'imported'}</span>}
          {hasDoc && <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/35 border border-white/10">{fmtTime(doc!.duration)}</span>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {!hasDoc ? (
            <>
              <button onClick={fetchYt} disabled={loading} className="no-drag px-3.5 py-1.5 rounded-full bg-white text-black text-[13px] font-semibold hover:bg-white/90 disabled:opacity-50">{loading ? 'Fetching…' : 'Fetch captions'}</button>
              <button onClick={importFile} disabled={loading} className="no-drag px-3.5 py-1.5 rounded-full bg-white/10 text-white/70 text-[13px] hover:bg-white/15 disabled:opacity-50">Import LRC/SRT/VTT</button>
            </>
          ) : (
            <>
              <button onClick={fetchYt} disabled={loading} className="no-drag px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[11px] text-white/60 disabled:opacity-50">Re-fetch</button>
              <button onClick={importFile} disabled={loading} className="no-drag px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[11px] text-white/60">Re-import</button>
              <button onClick={() => void window.stemkit.exportLyrics(videoId)} className="no-drag px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[11px] text-white/60">Export</button>
              <button onClick={async () => { await window.stemkit.deleteLyrics(videoId); setDoc(null) }} className="no-drag px-2.5 py-1 rounded-full bg-rose-500/10 hover:bg-rose-500/20 text-[11px] text-rose-300 border border-rose-400/15">Remove</button>
              <label className="no-drag flex items-center gap-1.5 ml-1 text-[11px] text-white/40 cursor-pointer"><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> follow</label>
            </>
          )}
        </div>
      </div>

      {err && <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-3 py-2 text-xs text-rose-200 whitespace-pre-wrap break-words">{err}</div>}

      {!hasDoc && !loading && !err && (
        <p className="text-xs text-white/30 leading-relaxed">YouTube auto-captions (EN) via the same engine you already use, or import any <code className="bg-white/10 px-1 rounded">.lrc/.srt/.vtt/.txt</code>. Stays in <code className="bg-white/10 px-1 rounded">songs/{videoId}/lyrics.json</code> next to <code className="bg-white/10 px-1 rounded">mix.wav</code> — local files import only.</p>
      )}
      {loading && <div className="text-xs text-violet-300 flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin" /> Fetching captions…</div>}

      {hasDoc && (
        <>
          {/* karaoke strip — big current line like Chordify's header */}
          <div className="rounded-xl bg-black/30 border border-white/10 px-4 py-3 min-h-[64px] flex items-center">
            {curI >= 0 ? (
              <p className="text-[15px] font-semibold leading-snug text-white transition-colors">{doc!.lines[curI].text}</p>
            ) : (
              <p className="text-sm text-white/25 italic">— play to follow lyrics —</p>
            )}
            <span className="ml-auto pl-4 shrink-0 text-[11px] font-mono text-white/30 hidden sm:block">{curI >= 0 ? fmtTime(doc!.lines[curI].time) : fmtTime(getPosition())} · {curI >= 0 ? `${curI + 1}/${doc!.lines.length}` : `${doc!.lines.length} lines`}</span>
          </div>

          {/* scrollable list — tap to seek, Chordify-style dense table */}
          <div
            ref={listRef}
            onScroll={() => {
              // if user scrolls manually, briefly pause auto-follow so we don't yank them
              // (only when they're not at the active line)
              // cheap heuristic: mark as user scroll; re-enable on next active change
            }}
            className="rounded-xl bg-black/20 border border-white/10 max-h-[260px] overflow-auto divide-y divide-white/5"
          >
            <div className="sticky top-0 bg-black/40 backdrop-blur px-3 py-1.5 text-[11px] uppercase tracking-widest text-white/30 flex gap-2">
              <span className="w-14">Time</span><span>Lyric</span><span className="ml-auto">Tap to jump</span>
            </div>
            {doc!.lines.map((l, i) => {
              const isActive = i === curI
              return (
                <button
                  key={i}
                  ref={(el) => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i) }}
                  onClick={() => handleManualSeek(l)}
                  className={`no-drag w-full text-left px-3 py-2 flex gap-3 items-baseline hover:bg-white/5 text-sm ${isActive ? 'bg-violet-500/20 text-white' : 'text-white/75'}`}
                >
                  <span className={`w-14 shrink-0 font-mono text-xs ${isActive ? 'text-violet-200' : 'text-white/35'}`}>{fmtTime(l.time)}</span>
                  <span className={`${isActive ? 'font-semibold text-white' : 'text-white/80'} leading-snug`}>{l.text}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-white/25 hidden sm:block">{l.duration.toFixed(1)}s</span>
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-white/30">Tap any line to jump · Play to auto-follow · Export as LRC/SRT/VTT/JSON · Time-synced to the same master clock as chords</p>
        </>
      )}
    </section>
  )
}
