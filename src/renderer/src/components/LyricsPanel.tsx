import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

interface Line {
  t: number
  text: string
}

function parseLrc(raw: string): Line[] {
  const lines: Line[] = []
  for (const row of raw.split(/\r?\n/)) {
    const tags = [...row.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)]
    if (tags.length === 0) continue
    const text = row.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const m of tags) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0
      lines.push({ t: Number(m[1]) * 60 + Number(m[2]) + frac, text })
    }
  }
  lines.sort((a, b) => a.t - b.t)
  return lines
}

function activeIndex(lines: Line[], pos: number): number {
  let lo = 0
  let hi = lines.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= pos) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return hit
}

interface Props {
  videoId: string
  title: string
  duration: number
  getPosition: () => number
}

export function LyricsPanel({
  videoId,
  title,
  duration,
  getPosition
}: Props): React.ReactElement {
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [syncedRaw, setSyncedRaw] = useState<string | null>(null)
  const [plain, setPlain] = useState<string | null>(null)
  const [current, setCurrent] = useState(-1)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const scrollRaf = useRef(0)
  const getPositionRef = useRef(getPosition)
  getPositionRef.current = getPosition

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setSyncedRaw(null)
    setPlain(null)
    setCurrent(-1)
    void window.stemkit
      .fetchLyrics(videoId, title, duration)
      .then((res) => {
        if (cancelled) return
        if (res.found && (res.synced || res.plain)) {
          setSyncedRaw(res.synced)
          setPlain(res.plain)
          setStatus('ready')
        } else {
          setStatus('missing')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('missing')
      })
    return () => {
      cancelled = true
    }
  }, [videoId, title, duration])

  const lines = useMemo(() => (syncedRaw ? parseLrc(syncedRaw) : []), [syncedRaw])
  const linesRef = useRef(lines)
  linesRef.current = lines

  useEffect(() => {
    if (status !== 'ready' || lines.length === 0) return
    let raf = 0
    const tick = (): void => {
      const idx = activeIndex(linesRef.current, getPositionRef.current())
      setCurrent((prev) => (prev === idx ? prev : idx))
    }
    tick()
    const loop = (): void => {
      tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [status, lines.length])

  useLayoutEffect(() => {
    const root = scrollerRef.current
    const el = activeRef.current
    if (!root || !el || current < 0) return

    cancelAnimationFrame(scrollRaf.current)
    const from = root.scrollTop
    const rootRect = root.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const delta = elRect.top + elRect.height / 2 - (rootRect.top + rootRect.height / 2)
    if (Math.abs(delta) < 1) return
    const to = from + delta
    const started = performance.now()
    const durationMs = 420
    const ease = (t: number): number => 1 - (1 - t) ** 3

    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / durationMs)
      root.scrollTop = from + (to - from) * ease(t)
      if (t < 1) scrollRaf.current = requestAnimationFrame(step)
    }
    scrollRaf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(scrollRaf.current)
  }, [current])

  return (
    <div
      ref={scrollerRef}
      className="mt-4 lyrics-panel rounded-2xl min-h-[280px] max-h-[52vh] overflow-y-auto overflow-x-hidden px-8 py-10"
    >
      {status === 'loading' && (
        <p className="text-center text-sm text-white/40 tracking-wide">Looking up lyrics…</p>
      )}
      {status === 'missing' && (
        <p className="text-center text-sm text-white/45">Lyrics not available</p>
      )}
      {status === 'ready' && lines.length > 0 && (
        <div className="lyric-list">
          {lines.map((line, i) => {
            const dist = current < 0 ? 1 : i - current
            const kind = dist === 0 ? 'is-active' : dist < 0 ? 'is-past' : 'is-next'
            return (
              <div
                key={`${line.t}-${i}`}
                ref={dist === 0 ? activeRef : undefined}
                className={`lyric-line ${kind}`}
              >
                {line.text}
              </div>
            )
          })}
        </div>
      )}
      {status === 'ready' && lines.length === 0 && plain && (
        <pre className="whitespace-pre-wrap text-center text-[16px] leading-relaxed text-white/70 font-sans">
          {plain}
        </pre>
      )}
      {status === 'ready' && lines.length === 0 && !plain && (
        <p className="text-center text-sm text-white/45">Lyrics not available</p>
      )}
    </div>
  )
}
