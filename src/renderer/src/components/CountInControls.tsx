import { useEffect, useRef, useState } from 'react'
import type { TempoSettings } from '../../../shared/types'

interface Props {
  bars: 0 | 1 | 2 | 3 | 4
  onBars: (bars: 0 | 1 | 2 | 3 | 4) => void
  tempo: TempoSettings
  onTempo: (tempo: TempoSettings) => void
  detectedBpm: number | null
  detectingTempo: boolean
  error: string | null
  disabled: boolean
}

export function CountInControls({ bars, onBars, tempo, onTempo, detectedBpm, detectingTempo, error, disabled }: Props): React.ReactElement {
  const selectedBpm = tempo.mode === 'manual'
    ? tempo.sourceBpm && detectedBpm !== null ? detectedBpm * (tempo.manualBpm ?? tempo.sourceBpm) / tempo.sourceBpm : tempo.manualBpm
    : detectedBpm
  const currentBpm = selectedBpm === null ? null : Math.round(selectedBpm)
  const [bpm, setBpm] = useState(currentBpm === null ? '' : String(currentBpm))
  const editing = useRef(false)
  const changed = useRef(false)
  useEffect(() => {
    if (!editing.current) setBpm(currentBpm === null ? '' : String(currentBpm))
  }, [currentBpm])
  const inputClass = 'no-drag rounded-lg bg-white/10 px-2 py-1 text-[14px] text-white/75 outline-none focus:ring-2 focus:ring-violet-400 disabled:opacity-40'
  const validBpm = bpm.trim() !== '' && Number.isFinite(Number(bpm)) && Number(bpm) >= 30 && Number(bpm) <= 300
  const commitBpm = (raw: string): void => {
    editing.current = false
    const number = Number(raw)
    const value = Math.round(number)
    const dirty = changed.current
    changed.current = false
    if (dirty && raw.trim() !== '' && Number.isFinite(number) && number >= 30 && number <= 300) {
      setBpm(String(value))
      if (value !== currentBpm) onTempo({ ...tempo, manualBpm: value, sourceBpm: detectedBpm ?? undefined, mode: 'manual' })
    } else setBpm(currentBpm === null ? '' : String(currentBpm))
  }

  return (
    <div className="border-t border-white/10 pt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-[14px] text-white/75">
        <div className="flex items-center gap-2">
          <span id="count-in-label">Count-in</span>
          <select aria-label="Count-in" aria-labelledby="count-in-label" value={bars} disabled={disabled} className={inputClass}
            onChange={event => onBars(Number(event.target.value) as Props['bars'])}>
            {([0, 1, 2, 3, 4] as const).map(value => (
              <option key={value} value={value}>{value === 0 ? 'Off' : `${value} ${value === 1 ? 'bar' : 'bars'}`}</option>
            ))}
          </select>
        </div>
        <>
          <label className="flex items-center gap-2">Beats per bar
            <select aria-label="Beats per bar" value={tempo.beatsPerBar} disabled={disabled} className={inputClass}
              onChange={(event) => onTempo({ ...tempo, beatsPerBar: Number(event.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <span>Tempo</span>
            <input aria-label="Tempo adjustment" type="range" min={30} max={300} step={1}
              title="Change practice tempo while keeping the original pitch. Arrow keys adjust by 1 BPM."
              value={validBpm ? Number(bpm) : currentBpm ?? 120} disabled={disabled} className="no-drag w-32"
              onFocus={() => { editing.current = true }}
              onChange={event => { editing.current = true; changed.current = true; setBpm(event.target.value) }}
              onPointerUp={event => commitBpm(event.currentTarget.value)}
              onPointerCancel={event => commitBpm(event.currentTarget.value)}
              onKeyUp={event => commitBpm(event.currentTarget.value)}
              onBlur={event => commitBpm(event.currentTarget.value)} />
            <input aria-label="Tempo BPM" aria-invalid={changed.current && bpm !== '' && !validBpm} type="number" min={30} max={300} step={1}
              placeholder="—" value={bpm} disabled={disabled} className={`${inputClass} w-20`}
              onFocus={() => { editing.current = true }}
              onChange={event => { changed.current = true; setBpm(event.target.value) }} onBlur={event => commitBpm(event.currentTarget.value)}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
            <span>BPM</span>
            <button type="button" aria-label="Reset to detected tempo" title="Restore detected tempo"
              disabled={disabled || tempo.mode === 'auto' || tempo.manualBpm === tempo.sourceBpm}
              onClick={() => onTempo({ ...tempo, mode: 'auto', manualBpm: null, sourceBpm: undefined })}
              className="no-drag flex h-7 w-7 items-center justify-center rounded-lg text-lg text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:opacity-30 disabled:hover:bg-transparent">
              <span aria-hidden="true">↺</span>
            </button>
            {detectedBpm === null && <span className="text-[11px] text-white/35">
              {detectingTempo ? 'Detecting…' : 'No tempo detected'}
            </span>}
          </div>
        </>
      </div>
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </div>
  )
}
