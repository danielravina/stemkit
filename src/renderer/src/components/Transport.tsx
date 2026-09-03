import { useEffect, useRef, useState } from 'react'
import { fmtTime } from '../lib/format'
import { PlayIcon, PauseIcon, ExternalIcon, LyricsIcon } from './Icons'

export type PresetId = 'all' | 'karaoke' | 'acapella' | 'drumnbass'

const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'acapella', label: 'Acapella' },
  { id: 'drumnbass', label: 'Drums + Bass' }
]

interface Props {
  playing: boolean
  duration: number
  getPosition: () => number
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  preset: PresetId
  onPreset: (p: PresetId) => void
  master: number
  onMaster: (v: number) => void
  youtubeUrl: string
  lyricsOpen: boolean
  onToggleLyrics: () => void
}

function SeekBar({
  duration,
  getPosition,
  onSeek,
  playing
}: {
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
  playing: boolean
}): React.ReactElement {
  const barRef = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      force((n) => (n + 1) % 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const frac = duration > 0 ? Math.min(1, getPosition() / duration) : 0

  const seekFromEvent = (clientX: number): void => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || duration <= 0) return
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onSeek(f * duration)
  }

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="text-xs text-white/50 font-mono tabular-nums w-12 text-right">
        {fmtTime(getPosition())}
      </span>
      <div
        ref={barRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seekFromEvent(e.clientX)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e.clientX)
        }}
        className="no-drag relative flex-1 h-4 flex items-center cursor-pointer group"
      >
        <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-400"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <div
          className="absolute w-3 h-3 rounded-full bg-white shadow transition-transform group-hover:scale-125"
          style={{ left: `calc(${frac * 100}% - 6px)` }}
        />
      </div>
      <span className="text-xs text-white/50 font-mono tabular-nums w-12">
        {fmtTime(duration)}
      </span>
    </div>
  )
}

export function Transport({
  playing,
  duration,
  getPosition,
  onTogglePlay,
  onSeek,
  preset,
  onPreset,
  master,
  onMaster,
  youtubeUrl,
  lyricsOpen,
  onToggleLyrics
}: Props): React.ReactElement {
  return (
    <div className="glass rounded-2xl px-5 py-4 mt-4 flex flex-col gap-4">
      <SeekBar duration={duration} getPosition={getPosition} onSeek={onSeek} playing={playing} />

      <div className="flex items-center justify-between">
        <button
          onClick={onTogglePlay}
          disabled={duration === 0}
          className="no-drag w-11 h-11 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-lg shadow-violet-500/20 disabled:opacity-40 disabled:hover:scale-100"
        >
          {playing ? (
            <PauseIcon className="w-5 h-5 translate-x-px" />
          ) : (
            <PlayIcon className="w-5 h-5 translate-x-0.5" />
          )}
        </button>

        <div className="no-drag flex items-center gap-2">
          <div className="flex items-center gap-1 bg-white/5 rounded-full p-1">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => onPreset(p.id)}
                className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all ${
                  preset === p.id
                    ? 'bg-white/90 text-black'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            onClick={onToggleLyrics}
            title={lyricsOpen ? 'Hide lyrics' : 'Show lyrics'}
            className={`px-3 py-1.5 rounded-full text-[13px] font-medium transition-all flex items-center gap-1.5 ${
              lyricsOpen
                ? 'bg-violet-400/90 text-black'
                : 'bg-white/5 text-white/60 hover:text-white'
            }`}
          >
            <LyricsIcon className="w-3.5 h-3.5" />
            Lyrics
          </button>
        </div>

        <div className="flex items-center gap-3 w-44">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-white/60 shrink-0">
            <path d="M11 5 6 9H3v6h3l5 4V5Z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={master}
            onChange={(e) => onMaster(parseFloat(e.target.value))}
            className="no-drag w-full"
            style={{
              background: `linear-gradient(to right, #fff ${master * 100}%, rgba(255,255,255,0.14) ${master * 100}%)`
            }}
          />
        </div>

        <button
          onClick={() => window.stemkit.openExternal(youtubeUrl)}
          title="Open on YouTube"
          className="no-drag text-white/40 hover:text-white transition-colors"
        >
          <ExternalIcon />
        </button>
      </div>
    </div>
  )
}
