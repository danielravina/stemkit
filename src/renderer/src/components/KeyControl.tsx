import { useEffect, useRef, useState } from 'react'
import type { SongKey } from '../../../shared/types'
import { KEY_NAMES } from '../../../shared/keys'

interface Props {
  songKey: SongKey | undefined
  onOverride: (key: string | null) => void
  // second line, rendered under the label (transpose controls arrive in a later PR)
  children?: React.ReactNode
}

const MAJORS = KEY_NAMES.slice(0, 12)
const MINORS = KEY_NAMES.slice(12)

export function KeyControl({ songKey, onOverride, children }: Props): React.ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const override = songKey?.override
  const effective = override ?? songKey?.detected ?? null
  const shown = songKey === undefined ? '…' : (effective ?? '?')
  const choose = (key: string | null): void => {
    onOverride(key)
    setOpen(false)
  }

  const keyButton = (name: string): React.ReactElement => (
    <button
      key={name}
      onClick={() => choose(name)}
      className={`px-1.5 py-1 rounded-md text-[12px] transition-colors ${
        name === effective ? 'bg-white/90 text-black' : 'text-white/70 hover:bg-white/10 hover:text-white'
      }`}
    >
      {name}
    </button>
  )

  return (
    <div ref={rootRef} className="relative flex flex-col items-start gap-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="no-drag flex items-center gap-1.5 text-[11px] tracking-[0.08em] text-white/45 hover:text-white/80 transition-colors"
      >
        <span className="uppercase">Original</span>
        <span aria-hidden>·</span>
        <span className="text-white/70">{shown}</span>
        {override && (
          <span title="Set manually" className="w-1.5 h-1.5 rounded-full bg-violet-400" />
        )}
      </button>
      {children}
      {open && (
        <div
          role="dialog"
          aria-label="Original key"
          className="no-drag absolute bottom-full left-0 mb-2 z-50 w-64 p-2 rounded-xl bg-[#16151d] border border-white/[0.08] shadow-2xl"
        >
          {songKey?.detected && (
            <button
              onClick={() => choose(null)}
              className={`w-full text-left px-2 py-1 mb-1 rounded-md text-[12px] transition-colors ${
                !override ? 'text-white bg-white/10' : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              Auto ({songKey.detected})
            </button>
          )}
          <div className="grid grid-cols-6 gap-0.5">{MAJORS.map(keyButton)}</div>
          <div className="grid grid-cols-6 gap-0.5 mt-1">{MINORS.map(keyButton)}</div>
        </div>
      )}
    </div>
  )
}
