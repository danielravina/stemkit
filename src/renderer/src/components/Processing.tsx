import { useEffect, useRef, useState } from 'react'
import type { JobProgress } from '../../../shared/types'
import { fmtTime } from '../lib/format'
import { SongThumb } from '../lib/thumbs'
import { XIcon } from './Icons'

const STAGES: { id: JobProgress['stage']; label: string }[] = [
  { id: 'metadata', label: 'Reading video' },
  { id: 'download', label: 'Downloading audio' },
  { id: 'convert', label: 'Converting' },
  { id: 'separate', label: 'Separating stems' },
  { id: 'finalize', label: 'Finishing up' }
]

const stageOrder = (stage: JobProgress['stage'] | undefined): number =>
  stage ? STAGES.findIndex((s) => s.id === stage) : -1

interface Props {
  job: JobProgress | null
  error: string | null
  // local-file jobs have no metadata/download stages and no yt-dlp to update
  isLocal?: boolean
  botSuspected: boolean
  onCancel: () => void
  onRetry: () => void
  onUpdateYtDlp: () => void
}

export function Processing({
  job,
  error,
  isLocal = false,
  botSuspected,
  onCancel,
  onRetry,
  onUpdateYtDlp
}: Props): React.ReactElement {
  const stages = isLocal ? STAGES.filter((s) => s.id !== 'metadata' && s.id !== 'download') : STAGES
  const stageIndex = job ? stages.findIndex((s) => s.id === job.stage) : -1

  const [timing, setTiming] = useState<{ elapsed: number; left: number | null } | null>(null)
  const jobRef = useRef(job)
  jobRef.current = job
  const tracker = useRef<{ videoId: string | null; start: number | null; ema: number | null }>({
    videoId: null,
    start: null,
    ema: null
  })

  useEffect(() => {
    const id = window.setInterval(() => {
      const j = jobRef.current
      const t = tracker.current
      // reset on a different job, on a retry (stage regressed), or on error
      if (!j || j.videoId !== t.videoId || stageOrder(j.stage) < stageOrder('separate')) {
        t.videoId = j?.videoId ?? null
        t.start = null
        t.ema = null
        setTiming(null)
        return
      }
      if (j.stage !== 'separate') {
        // finalize and beyond are instant; keep the last reading frozen
        return
      }
      if (t.start === null) t.start = Date.now()
      const elapsed = Math.round((Date.now() - t.start) / 1000)
      let left: number | null = null
      if (j.pct >= 3) {
        // self-calibrating estimate: elapsed over completed fraction,
        // smoothed so phase transitions and chunky updates don't wobble
        const projected = elapsed / (Math.min(j.pct, 99) / 100)
        t.ema = t.ema === null ? projected : t.ema * 0.9 + projected * 0.1
        left = Math.max(0, Math.round(t.ema - elapsed))
      }
      setTiming({ elapsed, left })
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="h-full flex items-center justify-center px-8">
      <div className="w-full max-w-md glass rounded-2xl p-7 rise-in">
        <div className="flex items-center gap-3.5">
          {job?.videoId ? (
            <SongThumb
              videoId={job.videoId}
              className="w-16 h-9 rounded-lg object-cover bg-white/5 block"
              iconClassName="w-4 h-4 text-white/25"
            />
          ) : (
            <span className="w-10 h-10 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin" />
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">
              {job?.title || (error ? 'Something went wrong' : 'Starting…')}
            </h2>
            <p className="text-xs text-white/40 truncate">{job?.message ?? ''}</p>
          </div>
        </div>

        <div className="mt-6 space-y-3.5">
          {stages.map((stage, i) => {
            const done = !error && i < stageIndex
            const active = !error && i === stageIndex
            const pct = active && job ? job.pct : done ? 100 : 0
            return (
              <div key={stage.id} className="flex items-center gap-3">
                <span
                  className={`w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold ${
                    done
                      ? 'bg-emerald-400 text-black'
                      : active
                        ? 'bg-violet-400 text-black animate-pulse'
                        : error && i >= stageIndex
                          ? 'bg-rose-400/80 text-black'
                          : 'bg-white/10'
                  }`}
                >
                  {done ? '✓' : ''}
                </span>
                <span className={`text-[13px] w-36 ${active ? 'text-white' : 'text-white/45'}`}>
                  {stage.label}
                </span>
                <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-400 transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>

        {timing && !error && (
          <p className="mt-4 text-center text-[11px] font-mono text-white/35">
            elapsed {fmtTime(timing.elapsed)}
            {timing.left !== null ? ` · ~${fmtTime(timing.left)} left` : ' · estimating…'}
          </p>
        )}

        {error && (
          <div className="mt-6 rise-in">
            <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-4 py-3 text-[13px] text-rose-200 break-words">
              {error}
            </div>
            <div className="mt-4 flex gap-2 justify-end">
              {botSuspected && !isLocal && (
                <button
                  onClick={onUpdateYtDlp}
                  className="px-4 py-2 rounded-lg glass text-[13px] hover:bg-white/10 transition-colors"
                >
                  Update yt-dlp & retry
                </button>
              )}
              <button
                onClick={onRetry}
                className="px-4 py-2 rounded-lg bg-white text-black text-[13px] font-semibold hover:bg-white/90 transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {!error && (
          <button
            onClick={onCancel}
            className="mt-7 mx-auto flex items-center gap-1.5 text-xs text-white/35 hover:text-rose-300 transition-colors"
          >
            <XIcon className="w-3 h-3" /> Cancel
          </button>
        )}
      </div>
    </div>
  )
}
