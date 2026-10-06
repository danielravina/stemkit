import { useEffect, useMemo, useRef } from 'react'
import type { StemId } from '../../../shared/types'
import { DownloadIcon } from './Icons'

export interface StemMeta {
  id: StemId
  label: string
  color: string
  icon: React.ReactNode
}

const BUCKETS = 1600

function computePeaks(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(BUCKETS)
  const data = buffer.getChannelData(0)
  const size = Math.floor(data.length / BUCKETS)
  for (let b = 0; b < BUCKETS; b++) {
    let max = 0
    const start = b * size
    const end = start + size
    for (let i = start; i < end; i += 4) {
      const v = Math.abs(data[i])
      if (v > max) max = v
    }
    out[b] = max
  }
  const globalMax = out.reduce((m, v) => Math.max(m, v), 0.0001)
  for (let b = 0; b < BUCKETS; b++) out[b] = Math.min(1, out[b] / globalMax)
  return out
}

interface Props {
  meta: StemMeta
  buffer: AudioBuffer | null
  duration: number
  getPosition: () => number
  audible: boolean
  volume: number
  muted: boolean
  soloed: boolean
  onToggleMute: () => void
  onToggleSolo: () => void
  onVolume: (v: number) => void
  onSeek: (seconds: number) => void
  onExport?: () => void
}

export function StemLane({
  meta,
  buffer,
  duration,
  getPosition,
  audible,
  volume,
  muted,
  soloed,
  onToggleMute,
  onToggleSolo,
  onVolume,
  onSeek,
  onExport
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaks = useMemo(() => (buffer ? computePeaks(buffer) : null), [buffer])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0

    const draw = (): void => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (w > 0 && (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr))) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (ctx && w > 0) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        if (peaks) {
          const frac =
            duration > 0 ? Math.min(1, Math.max(0, getPosition() / duration)) : 0
          const barW = w / peaks.length
          const barInner = Math.max(1, barW * 0.62)
          for (let i = 0; i < peaks.length; i++) {
            const amp = Math.max(0.04, peaks[i])
            const barH = amp * (h - 8)
            const x = i * barW + (barW - barInner) / 2
            const y = (h - barH) / 2
            const played = i / peaks.length <= frac
            ctx.fillStyle = played ? meta.color : 'rgba(255,255,255,0.13)'
            ctx.beginPath()
            ctx.roundRect(x, y, barInner, barH, 1.5)
            ctx.fill()
          }
          const px = frac * w
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.fillRect(px - 0.75, 0, 1.5, h)
        }
      }
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [peaks, duration, getPosition, meta.color])

  const handleSeek = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!peaks || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    onSeek(Math.max(0, Math.min(1, frac)) * duration)
  }

  return (
    <div
      className={`group flex items-center gap-3 rounded-xl px-3 py-2 transition-all duration-200 glass ${
        audible ? 'opacity-100' : 'opacity-45'
      }`}
    >
      <div className="flex items-center gap-2.5 w-36 shrink-0">
        <span
          className="flex items-center justify-center w-7 h-7 rounded-lg"
          style={{ background: `${meta.color}22`, color: meta.color }}
        >
          {meta.icon}
        </span>
        <span className="text-sm font-medium capitalize">{meta.label}</span>
      </div>

      <button
        onClick={onToggleMute}
        title="Mute"
        className={`no-drag w-6 h-6 rounded-md text-[11px] font-bold transition-colors ${
          muted
            ? 'bg-rose-400 text-black'
            : 'bg-white/5 text-white/50 hover:bg-white/10'
        }`}
      >
        M
      </button>
      <button
        onClick={onToggleSolo}
        title="Solo"
        className={`no-drag w-6 h-6 rounded-md text-[11px] font-bold transition-colors ${
          soloed
            ? 'bg-amber-300 text-black'
            : 'bg-white/5 text-white/50 hover:bg-white/10'
        }`}
      >
        S
      </button>

      <canvas
        ref={canvasRef}
        onClick={handleSeek}
        className="no-drag flex-1 h-14 rounded-lg cursor-pointer min-w-0"
      />

      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => onVolume(parseFloat(e.target.value))}
        className="no-drag w-24 shrink-0"
        style={{
          background: `linear-gradient(to right, ${meta.color} ${volume * 100}%, rgba(255,255,255,0.14) ${volume * 100}%)`
        }}
      />

      {onExport && (
        <button
          onClick={onExport}
          title="Export stem"
          className="no-drag w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-white flex items-center justify-center transition-colors shrink-0"
        >
          <DownloadIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
