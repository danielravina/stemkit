import { useEffect, useRef, useState } from 'react'

export interface LyricLine {
  time: number
  text: string
}

const LRC_LINE = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/

export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  for (const raw of text.split('\n')) {
    const m = LRC_LINE.exec(raw.trim())
    if (!m) continue
    const minutes = parseInt(m[1], 10)
    const seconds = parseFloat(m[2])
    const content = m[3].trim()
    if (!content) continue
    lines.push({ time: minutes * 60 + seconds, text: content })
  }
  return lines
}

interface Props {
  videoId: string
  getPosition: () => number
  onSeek: (seconds: number) => void
}

export function Lyrics({ videoId, getPosition, onSeek }: Props): React.ReactElement | null {
  const [lines, setLines] = useState<LyricLine[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLines([])
    setActiveIndex(-1)
    void window.stemkit.getLyrics(videoId).then((text) => {
      if (cancelled || !text) return
      setLines(parseLrc(text))
    })
    return () => {
      cancelled = true
    }
  }, [videoId])

  useEffect(() => {
    if (lines.length === 0) return
    const id = setInterval(() => {
      const pos = getPosition()
      let idx = -1
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= pos) idx = i
        else break
      }
      setActiveIndex((prev) => (prev === idx ? prev : idx))
    }, 150)
    return () => clearInterval(id)
  }, [lines, getPosition])

  useEffect(() => {
    const container = listRef.current
    const el = lineRefs.current[activeIndex]
    if (!container || !el) return
    container.scrollTo({
      top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
      behavior: 'smooth'
    })
  }, [activeIndex])

  if (lines.length === 0) return null

  return (
    <div
      ref={listRef}
      className="glass rounded-2xl w-72 shrink-0 max-h-[420px] overflow-y-auto px-3 py-4 space-y-1"
    >
      {lines.map((line, i) => (
        <button
          key={i}
          ref={(el) => {
            lineRefs.current[i] = el
          }}
          onClick={() => onSeek(line.time)}
          className={`no-drag block w-full text-left px-3 py-1.5 rounded-lg text-[13px] leading-relaxed transition-colors ${
            i === activeIndex
              ? 'bg-violet-500/20 text-white font-medium'
              : 'text-white/45 hover:text-white/70 hover:bg-white/5'
          }`}
        >
          {line.text}
        </button>
      ))}
    </div>
  )
}
