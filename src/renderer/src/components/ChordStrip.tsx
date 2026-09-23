import { useEffect, useRef } from 'react'
import type { ChordsDoc } from '../../../shared/types'
import { chordColor } from '../lib/chords'

interface Props {
  doc: ChordsDoc | null
  duration: number
  getPosition: () => number
  onSeek: (t: number) => void
}

export function ChordStrip({ doc, duration, getPosition, onSeek }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const draw = (): void => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      if (w>0 && (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr))) {
        canvas.width = Math.round(w*dpr)
        canvas.height = Math.round(h*dpr)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx || w===0) { raf=requestAnimationFrame(draw); return }
      ctx.setTransform(dpr,0,0,dpr,0,0)
      ctx.clearRect(0,0,w,h)
      if (!doc || doc.chords.length===0 || duration<=0) {
        ctx.fillStyle='rgba(255,255,255,0.06)'
        ctx.fillRect(0,0,w,h)
        ctx.fillStyle='rgba(255,255,255,0.22)'
        ctx.font='11px ui-monospace, monospace'
        ctx.textAlign='center'
        ctx.fillText('No chords — hit Analyze', w/2, h/2+4)
        raf=requestAnimationFrame(draw); return
      }
      const t = getPosition()
      // draw segments
      for (const c of doc.chords) {
        const x0 = (c.time / duration) * w
        const x1 = ((c.time + c.duration) / duration) * w
        const cw = Math.max(1, x1 - x0)
        const isActive = t >= c.time && t < c.time + c.duration
        ctx.fillStyle = c.chord==="N" ? 'rgba(255,255,255,0.06)' : chordColor(c.chord)
        ctx.globalAlpha = isActive ? 0.95 : 0.55
        // rounded rect via path
        const r = 6
        ctx.beginPath()
        ctx.roundRect(x0+1, 4, cw-2, h-8, r)
        ctx.fill()
        ctx.globalAlpha = 1
        // label
        if (cw > 28) {
          ctx.fillStyle = isActive ? '#0b0b10' : 'rgba(0,0,0,0.72)'
          // pick font size by width
          const fontSize = cw > 60 ? 11 : 10
          ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui`
          ctx.textAlign='center'
          let label = c.chord
          if (cw < 44 && label.length>3) label = label.slice(0,3)
          ctx.fillText(label, x0 + cw/2, h/2 + 4, cw - 6)
        }
      }
      // playhead
      const frac = duration>0 ? Math.min(1, Math.max(0, t/duration)) : 0
      const px = frac * w
      ctx.fillStyle='rgba(255,255,255,0.92)'
      ctx.fillRect(px-0.75, 0, 1.5, h)
      // knob
      ctx.beginPath(); ctx.arc(px, 4, 4, 0, Math.PI*2); ctx.fill()
      raf=requestAnimationFrame(draw)
    }
    raf=requestAnimationFrame(draw)
    return ()=> cancelAnimationFrame(raf)
  }, [doc, duration, getPosition])

  const onPointer = (clientX: number): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || duration<=0) return
    const f = Math.min(1, Math.max(0, (clientX - rect.left)/rect.width))
    onSeek(f*duration)
  }

  return (
    <div
      ref={ref}
      className="glass rounded-xl overflow-hidden"
      style={{ height: 56 }}
      onPointerDown={(e)=>{ (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onPointer(e.clientX) }}
      onPointerMove={(e)=>{ if(e.buttons===1) onPointer(e.clientX) }}
    >
      <canvas ref={canvasRef} className="w-full h-full block cursor-pointer" style={{ width:'100%', height: 56 }} />
    </div>
  )
}
