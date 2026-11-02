import { useEffect, useRef, useState } from 'react'
import { fmtTime } from '../lib/format'
import { PlayIcon, PauseIcon, ExternalIcon } from './Icons'

export type PresetId = 'all' | 'karaoke' | 'acapella' | 'drumnbass'

const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'acapella', label: 'Acapella' },
  { id: 'drumnbass', label: 'Drums + Bass' }
]

function MetronomeIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 2 4 22h16L12 2Z" />
      <path d="m12 6 5 10" />
      <circle cx="15.5" cy="13.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

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
  // local-file songs have no video to link out to
  youtubeUrl?: string
  loopA: number | null
  loopB: number | null
  isLoopActive: boolean
  onSetPointA: () => void
  onSetPointB: () => void
  onToggleLoop: () => void
  onClearLoop: () => void
  // Metronome props
  metronomeOn: boolean
  onToggleMetronome: () => void
  bpm?: number
  meter?: number
  detectingBpm?: boolean
  onDetectBpm?: () => void
}

function SeekBar({
  duration,
  getPosition,
  onSeek,
  playing,
  loopA,
  loopB,
  isLoopActive
}: {
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
  playing: boolean
  loopA: number | null
  loopB: number | null
  isLoopActive: boolean
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
        className="no-drag relative flex-1 h-6 flex items-center cursor-pointer group"
      >
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden relative">
          <div
            className="h-full rounded-full bg-linear-to-r from-violet-400 to-emerald-400"
            style={{ width: `${frac * 100}%` }}
          />
        </div>

        {/* Highlighted A-B Loop Region */}
        {loopA !== null && loopB !== null && duration > 0 && (
          <div
            className={`absolute h-2 -top-px rounded pointer-events-none transition-colors ${
              isLoopActive
                ? 'bg-emerald-400/30 border-x-2 border-emerald-400 shadow-sm shadow-emerald-500/20'
                : 'bg-white/15 border-x border-white/30'
            }`}
            style={{
              left: `${(Math.min(loopA, loopB) / duration) * 100}%`,
              width: `${(Math.abs(loopB - loopA) / duration) * 100}%`
            }}
          />
        )}

        {/* Marker A Pin */}
        {loopA !== null && duration > 0 && (
          <div
            className={`absolute -top-3.5 pointer-events-none flex flex-col items-center z-10 transition-transform ${
              loopB !== null && Math.abs(loopB - loopA) / duration < 0.05
                ? loopA <= loopB
                  ? '-translate-x-[calc(100%+1px)] items-end'
                  : 'translate-x-px items-start'
                : '-translate-x-1/2 items-center'
            }`}
            style={{ left: `${(loopA / duration) * 100}%` }}
            title={`Point A: ${fmtTime(loopA)}`}
          >
            <span className="text-[9px] font-bold font-mono px-1 rounded-sm bg-emerald-400 text-black leading-none py-0.5 shadow">
              A
            </span>
            <div className="w-0.5 h-1.5 bg-emerald-400 -mt-px mr-0.5" />
          </div>
        )}

        {/* Marker B Pin */}
        {loopB !== null && duration > 0 && (
          <div
            className={`absolute -top-3.5 pointer-events-none flex flex-col items-center z-10 transition-transform ${
              loopA !== null && Math.abs(loopB - loopA) / duration < 0.05
                ? loopB >= loopA
                  ? 'translate-x-px items-start'
                  : '-translate-x-[calc(100%+1px)] items-end'
                : '-translate-x-1/2 items-center'
            }`}
            style={{ left: `${(loopB / duration) * 100}%` }}
            title={`Point B: ${fmtTime(loopB)}`}
          >
            <span className="text-[9px] font-bold font-mono px-1 rounded-sm bg-emerald-400 text-black leading-none py-0.5 shadow">
              B
            </span>
            <div className="w-0.5 h-1.5 bg-emerald-400 -mt-px ml-0.5" />
          </div>
        )}

        {/* Playhead thumb */}
        <div
          className="absolute w-3 h-3 rounded-full bg-white shadow transition-transform group-hover:scale-125 z-20"
          style={{ left: `calc(${frac * 100}% - 6px)` }}
        />
      </div>
      <span className="text-xs text-white/50 font-mono tabular-nums w-12">
        {fmtTime(duration)}
      </span>
    </div>
  )
}

const SKIP_STEP = 5
const SKIP_STEP_SHIFT = 15

// tracks whether Shift is held, so the skip buttons can show the bigger step
function useShiftHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => setHeld(e.shiftKey)
    // keyup is lost if Shift is released while the window is unfocused
    const onBlur = (): void => setHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  return held
}

function SkipButton({
  direction,
  shiftHeld,
  disabled,
  onSkip
}: {
  direction: -1 | 1
  shiftHeld: boolean
  disabled: boolean
  onSkip: (seconds: number) => void
}): React.ReactElement {
  const back = direction < 0
  const seconds = shiftHeld ? SKIP_STEP_SHIFT : SKIP_STEP
  return (
    <button
      // read Shift from the click itself, in case the keyboard state went stale
      onClick={(e) => onSkip(direction * (e.shiftKey ? SKIP_STEP_SHIFT : SKIP_STEP))}
      disabled={disabled}
      title={`${back ? 'Back' : 'Forward'} ${seconds} seconds (Shift: ${SKIP_STEP_SHIFT})`}
      className="no-drag w-9 h-9 rounded-full flex flex-col items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${back ? '' : '-scale-x-100'}`}>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5" />
      </svg>
      <span className="text-[10px] font-mono tabular-nums leading-none mt-0.5">{seconds}</span>
    </button>
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
  loopA,
  loopB,
  isLoopActive,
  onSetPointA,
  onSetPointB,
  onToggleLoop,
  onClearLoop,
  metronomeOn,
  onToggleMetronome,
  bpm,
  meter,
  detectingBpm,
  onDetectBpm
}: Props): React.ReactElement {
  const skip = (seconds: number): void => onSeek(getPosition() + seconds)
  const shiftHeld = useShiftHeld()

  return (
    <div className="glass rounded-2xl px-5 py-4 mt-4 flex flex-col gap-4">
      <SeekBar
        duration={duration}
        getPosition={getPosition}
        onSeek={onSeek}
        playing={playing}
        loopA={loopA}
        loopB={loopB}
        isLoopActive={isLoopActive}
      />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <SkipButton direction={-1} shiftHeld={shiftHeld} disabled={duration === 0} onSkip={skip} />
          <button
            onClick={onTogglePlay}
            disabled={duration === 0}
            className="no-drag w-11 h-11 mx-1 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-lg shadow-violet-500/20 disabled:opacity-40 disabled:hover:scale-100"
          >
            {playing ? (
              <PauseIcon className="w-5 h-5" />
            ) : (
              <PlayIcon className="w-5 h-5 -translate-x-px" />
            )}
          </button>
          <SkipButton direction={1} shiftHeld={shiftHeld} disabled={duration === 0} onSkip={skip} />
        </div>

        {/* A-B Looping Controls */}
        <div className="no-drag flex items-center gap-1 bg-white/5 border border-white/5 rounded-full p-1">
          <button
            onClick={onSetPointA}
            disabled={duration === 0}
            title={loopA !== null ? `Point A: ${fmtTime(loopA)} (Click to reset/move, shortcut: [ or I)` : 'Set Point A at current position (shortcut: [ or I)'}
            className={`px-3 py-1 rounded-full text-xs font-mono font-medium transition-all ${
              loopA !== null
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                : 'text-white/60 hover:text-white hover:bg-white/10'
            }`}
          >
            {loopA !== null ? `A: ${fmtTime(loopA)}` : 'Set A'}
          </button>

          <button
            onClick={onSetPointB}
            disabled={duration === 0}
            title={loopB !== null ? `Point B: ${fmtTime(loopB)} (Click to move, shortcut: ] or O)` : 'Set Point B at current position (shortcut: ] or O)'}
            className={`px-3 py-1 rounded-full text-xs font-mono font-medium transition-all ${
              loopB !== null
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                : 'text-white/60 hover:text-white hover:bg-white/10'
            }`}
          >
            {loopB !== null ? `B: ${fmtTime(loopB)}` : 'Set B'}
          </button>

          <button
            onClick={onToggleLoop}
            disabled={loopA === null || loopB === null}
            title={
              loopA === null || loopB === null
                ? 'Set points A and B to enable loop'
                : isLoopActive
                  ? 'Disable A-B Loop (shortcut: L or \\)'
                  : 'Enable A-B Loop (shortcut: L or \\)'
            }
            className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all ${
              isLoopActive
                ? 'bg-emerald-400 text-black font-semibold shadow-md shadow-emerald-500/30'
                : 'text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <path d="m17 2 4 4-4 4" />
              <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
              <path d="m7 22-4-4 4-4" />
              <path d="M21 13v1a4 4 0 0 1-4 4H3" />
            </svg>
            <span>Loop</span>
          </button>

          {(loopA !== null || loopB !== null) && (
            <button
              onClick={onClearLoop}
              title="Clear A-B Loop points (shortcut: Esc or C)"
              className="w-6 h-6 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Metronome / BPM Controls */}
        <div className="no-drag flex items-center gap-1.5 bg-white/5 border border-white/5 rounded-full p-1">
          <button
            onClick={onToggleMetronome}
            disabled={!bpm && !detectingBpm}
            title={metronomeOn ? 'Turn Metronome Off (M)' : 'Turn Metronome On (M)'}
            className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 transition-all ${
              metronomeOn
                ? 'bg-amber-400 text-black font-semibold shadow-md shadow-amber-500/30'
                : 'text-white/60 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent'
            }`}
          >
            <MetronomeIcon className="w-3.5 h-3.5" />
            <span>Click</span>
          </button>



          {detectingBpm ? (
            <span className="text-[11px] font-mono text-amber-300 animate-pulse px-2">
              Detecting…
            </span>
          ) : bpm ? (
            <span
              className="text-xs font-mono font-medium text-white/90 px-2 py-0.5 rounded-full bg-white/5"
              title={`Meter: ${meter ?? 4}/4`}
            >
              {bpm} BPM
            </span>
          ) : onDetectBpm ? (
            <button
              onClick={onDetectBpm}
              className="text-[11px] font-medium text-white/50 hover:text-white hover:bg-white/10 px-2 py-1 rounded-full transition-colors"
            >
              Detect BPM
            </button>
          ) : null}
        </div>

        <div className="no-drag flex items-center gap-1 bg-white/5 rounded-full p-1">
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

        {youtubeUrl && (
          <button
            onClick={() => window.stemkit.openExternal(youtubeUrl)}
            title="Open on YouTube"
            className="no-drag text-white/40 hover:text-white transition-colors"
          >
            <ExternalIcon />
          </button>
        )}
      </div>
    </div>
  )
}
