import { useEffect, useRef, useState } from 'react'
import { MIX_ID, canExport, type ExportMode } from '../../../shared/export-rules'
import { formatShift, transposeKey } from '../../../shared/keys'
import type { StemMeta } from '../lib/stems'
import { XIcon } from './Icons'

interface Props {
  stems: StemMeta[]
  initial: Set<string>
  semitones: number
  originalKey: string | null
  onClose(): void
  // resolves false when the user cancelled the save/folder picker
  onExport(mode: ExportMode, selected: Set<string>, shifted: boolean): Promise<boolean>
}

export function ExportDialog({
  stems,
  initial,
  semitones,
  originalKey,
  onClose,
  onExport
}: Props): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initial))
  const [shifted, setShifted] = useState(true)
  const [busy, setBusy] = useState<ExportMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  // hovering or focusing "Export mixed" previews that the original mix is left out
  const [mixedHover, setMixedHover] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  // a render can take a while and the session must reach exportEnd, so the
  // dialog stays up until the export settles
  const close = (): void => {
    if (!busy) onClose()
  }

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (mode: ExportMode): Promise<void> => {
    setBusy(mode)
    setError(null)
    try {
      // a cancelled picker keeps the dialog and its checkboxes for another try
      if (await onExport(mode, selected, semitones !== 0 && shifted)) onClose()
      else setBusy(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }

  const shiftedKey = originalKey ? transposeKey(originalKey, semitones) : null
  const originalLabel = shiftedKey ? `Original (${originalKey})` : 'Original'
  const shiftedLabel = shiftedKey
    ? `Shifted (${shiftedKey} ${formatShift(semitones)})`
    : `Shifted (${formatShift(semitones)})`
  const mixDimmed = mixedHover || busy === 'mixed'

  const rowClass =
    'flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] hover:bg-white/[0.04] transition-colors cursor-pointer'
  const buttonClass =
    'no-drag flex-1 rounded-xl px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        aria-busy={busy !== null}
        tabIndex={-1}
        className="w-full max-w-sm mx-4 rounded-2xl border border-white/[0.08] bg-[#16151d] shadow-2xl rise-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/[0.07]">
          <h2 id="export-title" className="text-[14px] font-semibold tracking-tight">
            Export
          </h2>
          <button
            onClick={close}
            disabled={busy !== null}
            title="Close"
            className="no-drag w-7 h-7 rounded-lg hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors disabled:opacity-40"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <fieldset disabled={busy !== null} className="space-y-0.5">
            <legend className="sr-only">Tracks</legend>
            {stems.map((meta) => (
              <label key={meta.id} className={rowClass}>
                <input
                  type="checkbox"
                  checked={selected.has(meta.id)}
                  onChange={() => toggle(meta.id)}
                  className="w-4 h-4 accent-violet-500"
                />
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
                <span className="capitalize text-white/80">{meta.label}</span>
              </label>
            ))}
            <label className={`${rowClass} ${mixDimmed ? 'opacity-40' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(MIX_ID)}
                onChange={() => toggle(MIX_ID)}
                className="w-4 h-4 accent-violet-500"
              />
              <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-white/40" />
              <span className="text-white/80">Original mix</span>
              {mixDimmed && (
                <span className="ml-auto text-[11px] text-white/50">already contains every stem</span>
              )}
            </label>
          </fieldset>

          {semitones !== 0 && (
            <fieldset disabled={busy !== null} className="space-y-1">
              <legend className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5">Pitch</legend>
              <div className="flex gap-2">
                {[
                  { value: false, label: originalLabel },
                  { value: true, label: shiftedLabel }
                ].map((opt) => (
                  <label
                    key={opt.label}
                    className={`flex-1 flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] cursor-pointer border transition-colors ${
                      shifted === opt.value
                        ? 'border-violet-400/50 bg-violet-500/10 text-white'
                        : 'border-white/[0.08] text-white/60 hover:bg-white/[0.04]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="export-pitch"
                      checked={shifted === opt.value}
                      onChange={() => setShifted(opt.value)}
                      className="accent-violet-500"
                    />
                    <span className="truncate">{opt.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-rose-500/10 border border-rose-400/20 px-3 py-2 text-xs text-rose-200 break-words">
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            {/* hover lives on a wrapper: disabled buttons get no mouse events,
                and that is exactly when the hint explains why */}
            <span
              className="flex-1 flex"
              onMouseEnter={() => setMixedHover(true)}
              onMouseLeave={() => setMixedHover(false)}
            >
              <button
                onClick={() => void run('mixed')}
                onFocus={() => setMixedHover(true)}
                onBlur={() => setMixedHover(false)}
                disabled={busy !== null || !canExport(selected, 'mixed')}
                className={`${buttonClass} bg-violet-500 text-white hover:bg-violet-400`}
              >
                {busy === 'mixed' ? 'Exporting…' : 'Export mixed'}
              </button>
            </span>
            <button
              onClick={() => void run('separate')}
              disabled={busy !== null || !canExport(selected, 'separate')}
              className={`${buttonClass} glass text-white/80 hover:text-white hover:bg-white/10`}
            >
              {busy === 'separate' ? 'Exporting…' : 'Export separately'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
