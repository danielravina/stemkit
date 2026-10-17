import { useRef } from 'react'

interface Props {
  label: string
  color: string
  value: number
  onChange: (value: number) => void
  disabled?: boolean
}

export function PanKnob({ label, color, value, onChange, disabled = false }: Props): React.ReactElement {
  const drag = useRef<{ id: number; x: number; y: number; value: number } | null>(null)
  const change = (next: number): void => {
    onChange(Math.round(Math.max(-1, Math.min(1, next)) * 100) / 100)
  }
  const text = value === 0 ? 'C' : `${value < 0 ? 'L' : 'R'} ${Math.round(Math.abs(value) * 100)}`

  return (
    <div className="no-drag flex w-12 shrink-0 flex-col items-center gap-0.5">
      <span className="text-[12px] uppercase text-white/75">Pan</span>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label={`${label} pan`}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={value}
        aria-valuetext={value === 0 ? 'Center' : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? 'left' : 'right'}`}
        title="Drag up or right to pan right. Double-click to center."
        className="relative h-7 w-7 rounded-full border border-white/20 bg-white/5 cursor-ew-resize touch-none select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300"
        onPointerDown={(e) => {
          if (disabled || e.button !== 0 || drag.current) return
          e.preventDefault()
          e.currentTarget.focus()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, value }
        }}
        onPointerMove={(e) => {
          const start = drag.current
          if (!disabled && start?.id === e.pointerId) {
            change(start.value + (e.clientX - start.x + start.y - e.clientY) / 100)
          }
        }}
        onPointerUp={(e) => {
          if (drag.current?.id !== e.pointerId) return
          drag.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onPointerCancel={() => { drag.current = null }}
        onLostPointerCapture={() => { drag.current = null }}
        onDoubleClick={() => { if (!disabled) change(0) }}
        onKeyDown={(e) => {
          if (disabled) return
          e.stopPropagation()
          const step = e.shiftKey ? 0.1 : 0.01
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') change(value + step)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') change(value - step)
          else if (e.key === 'Home') change(-1)
          else if (e.key === 'End') change(1)
          else return
          e.preventDefault()
        }}
      >
        <span className="absolute inset-0" style={{ transform: `rotate(${value * 135}deg)` }}>
          <span className="absolute left-1/2 top-1 h-2.5 w-0.5 -translate-x-1/2 rounded-full" style={{ background: color }} />
        </span>
      </div>
      <span className="text-[12px] tabular-nums text-white/75">{text}</span>
    </div>
  )
}
