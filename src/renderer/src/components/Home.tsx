import { useEffect, useRef, useState } from 'react'
import {
  MODEL_DEFAULT,
  MODEL_EXTENDED,
  DEFAULT_STEMS,
  type AppSettings,
  type SearchResult,
  type Song,
  type StemId
} from '../../../shared/types'
import { parseVideoId } from '../../../shared/url'
import { STEM_INFO, PREFERRED_ORDER } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { GearIcon, FolderIcon } from './Icons'

interface Props {
  hasSongs: boolean
  songs: Song[]
  pending?: Record<string, { label: string; error?: boolean }>
  settings?: AppSettings
  onStart: (url: string, model: string, stems?: string[]) => void
  onStartLocal: (filePath: string, model: string, stems?: string[]) => void
  onSelect: (videoId: string) => void
  onOpenSettings: () => void
}

const ALL_STEMS = PREFERRED_ORDER

export function Home({
  hasSongs,
  songs,
  pending = {},
  settings,
  onStart,
  onStartLocal,
  onSelect,
  onOpenSettings
}: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<StemId>>(new Set<StemId>(DEFAULT_STEMS as StemId[]))
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchedFor, setSearchedFor] = useState('')
  const seqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const usesExtended = [...selected].some((id) => id === 'guitar' || id === 'piano')
  const derivedModel = usesExtended ? MODEL_EXTENDED : MODEL_DEFAULT
  const orderedSelection = ALL_STEMS.filter((id) => selected.has(id))
  // the fine-tuned engine only covers the standard 4-stem split; guitar and
  // piano always run through the 6-source engine, so they're unavailable
  // while it's on
  const ftOn = !!settings?.htdemucsFt
  useEffect(() => {
    if (!ftOn) return
    setSelected((prev) => {
      if (!prev.has('guitar') && !prev.has('piano')) return prev
      const next = new Set(prev)
      next.delete('guitar')
      next.delete('piano')
      return next
    })
  }, [ftOn])
  const engineLabel = usesExtended
    ? '6-source engine'
    : settings?.roformerVocals
      ? 'studio engine'
      : settings?.htdemucsFt
        ? 'enhanced engine'
        : 'standard engine'
  const timeHint = usesExtended || settings?.roformerVocals
    ? 'A 4-minute song takes about three minutes to split.'
    : settings?.htdemucsFt || settings?.shifts === 2
      ? 'A 4-minute song takes a little longer with the quality options on.'
      : 'A 4-minute song takes about three minutes to split.'

  const toggleStem = (id: StemId): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startWithSelection = (videoIdOrUrl: string): void => {
    onStart(
      videoIdOrUrl.startsWith('http') ? videoIdOrUrl : `https://www.youtube.com/watch?v=${videoIdOrUrl}`,
      derivedModel,
      orderedSelection
    )
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const runSearch = async (q: string): Promise<void> => {
    const seq = ++seqRef.current
    setSearching(true)
    setSearchError(null)
    try {
      const res = await window.stemkit.searchYouTube(q)
      if (seqRef.current === seq) {
        setResults(res)
        setSearchedFor(q)
      }
    } catch (err) {
      if (seqRef.current === seq) {
        setSearchError(err instanceof Error ? err.message : String(err))
        setResults([])
      }
    } finally {
      if (seqRef.current === seq) setSearching(false)
    }
  }

  const handleInput = (value: string): void => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = value.trim()
    if (!trimmed || parseVideoId(trimmed)) {
      setResults([])
      setSearchError(null)
      setSearching(false)
      return
    }
    debounceRef.current = setTimeout(() => void runSearch(trimmed), 450)
  }

  const submit = (): void => {
    const trimmed = query.trim()
    if (!trimmed || selected.size === 0) return
    if (parseVideoId(trimmed)) {
      startWithSelection(trimmed)
      setQuery('')
      setResults([])
      return
    }
    if (searching) return
    void runSearch(trimmed)
  }

  const startResult = (r: SearchResult): void => {
    startWithSelection(r.videoId)
  }

  const pickAndStart = async (): Promise<void> => {
    if (selected.size === 0) return
    const filePath = await window.stemkit.pickAudioFile()
    if (filePath) onStartLocal(filePath, derivedModel, orderedSelection)
  }

  return (
    <div className="h-full flex flex-col items-center px-8 pt-[8vh] pb-6 overflow-y-auto">
      <div className="w-full max-w-2xl">
        <h1 className="text-center text-[30px] font-bold tracking-tight leading-tight bg-gradient-to-r from-violet-300 via-white to-emerald-200 bg-clip-text text-transparent">
          Turn any track into stems.
        </h1>
        <p className="text-center text-white/45 mt-2.5 text-[14px]">
          Search YouTube, paste a link, or split an audio file from your computer — separated locally.
        </p>

        <div className="mt-6 flex gap-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Search YouTube or paste a link…"
            spellCheck={false}
            className="no-drag flex-1 glass rounded-xl px-4 py-3 text-sm outline-none placeholder:text-white/25 focus:ring-2 focus:ring-violet-400/60 transition-shadow"
          />
          <button
            onClick={() => void pickAndStart()}
            disabled={selected.size === 0}
            title="Split a local audio file (mp3, wav, flac…)"
            className="no-drag glass rounded-xl w-[52px] flex items-center justify-center text-white/45 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            <FolderIcon className="w-[18px] h-[18px] pointer-events-none" />
          </button>
          <button
            onClick={submit}
            disabled={!query.trim() || selected.size === 0}
            className="no-drag px-5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-40 disabled:hover:bg-white disabled:active:scale-100"
          >
            {parseVideoId(query) ? 'Split' : 'Search'}
          </button>
        </div>

        <div className="mt-3.5 glass rounded-2xl px-4 py-3">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">
              Instruments
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] text-white/30 font-medium">
                {selected.size === 0
                  ? 'select at least one'
                  : `${engineLabel} · ${selected.size} stems`}
              </span>
              <button
                onClick={onOpenSettings}
                title="Settings"
                className="no-drag w-5 h-5 rounded-md hover:bg-white/10 text-white/35 hover:text-white flex items-center justify-center transition-colors"
              >
                <GearIcon className="w-3 h-3" />
              </button>
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {ALL_STEMS.map((id) => {
              if (ftOn && (id === 'guitar' || id === 'piano')) return null
              const info = STEM_INFO[id]
              const on = selected.has(id)
              return (
                <button
                  key={id}
                  onClick={() => toggleStem(id)}
                  className={`no-drag flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium capitalize border transition-all ${
                    on
                      ? 'border-transparent'
                      : 'border-white/[0.08] bg-white/[0.03] text-white/35 hover:text-white/60 hover:border-white/20'
                  }`}
                  style={
                    on
                      ? {
                          background: `${info.color}1f`,
                          color: info.color,
                          boxShadow: `inset 0 0 0 1px ${info.color}55`
                        }
                      : undefined
                  }
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full transition-opacity"
                    style={{ background: info.color, opacity: on ? 1 : 0.3 }}
                  />
                  {info.label}
                </button>
              )
            })}
          </div>
        </div>

        {(searching || searchError || results.length > 0) && (
          <div className="mt-6">
            {searching && (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="glass rounded-xl h-[52px] animate-pulse" style={{ animationDelay: `${i * 120}ms` }} />
                ))}
              </div>
            )}
            {!searching && searchError && (
              <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-4 py-3 text-[13px] text-rose-200">
                Search failed: {searchError}
              </div>
            )}
            {!searching && !searchError && results.length > 0 && (
              <div className="space-y-1 rise-in">
                <p className="text-[11px] uppercase tracking-widest text-white/30 font-semibold mb-2">
                  Results for “{searchedFor}”
                </p>
                {results.map((r) => {
                  const p = pending[r.videoId]
                  const inProgress = !!p && !p.error
                  const failed = !!p?.error
                  const saved = !p && songs.some((s) => s.videoId === r.videoId)
                  return (
                    <button
                      key={r.videoId}
                      onClick={() => (inProgress || failed || saved ? onSelect(r.videoId) : startResult(r))}
                      title={
                        inProgress
                          ? 'View splitting progress'
                          : failed
                            ? 'View error'
                            : saved
                              ? 'Open from your library'
                              : 'Split into stems'
                      }
                      className={`no-drag group w-full flex items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.06] transition-colors ${
                        inProgress || failed || saved ? '' : 'cursor-pointer'
                      }`}
                    >
                      <span className="relative shrink-0">
                        <img
                          src={`https://i.ytimg.com/vi/${r.videoId}/default.jpg`}
                          alt=""
                          className="w-[67px] h-[38px] rounded-md object-cover bg-white/5"
                          draggable={false}
                        />
                        {typeof r.duration === 'number' && r.duration > 0 && (
                          <span className="absolute bottom-1 right-1 bg-black/80 rounded text-[9px] font-mono px-1">
                            {fmtTime(r.duration)}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] truncate text-white/85">{r.title}</span>
                        <span className="block text-[11px] text-white/35 mt-0.5">{r.channel}</span>
                      </span>
                      {inProgress ? (
                        <span className="shrink-0 flex items-center gap-2 pr-2 text-violet-300">
                          <span className="text-[11px] font-medium max-w-[120px] truncate">{p!.label}</span>
                          <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin" />
                        </span>
                      ) : failed ? (
                        <span className="shrink-0 pr-2 text-[11px] font-medium text-rose-300">failed — view</span>
                      ) : saved ? (
                        <span className="shrink-0 pr-2 text-[11px] font-medium text-emerald-300 group-hover:text-emerald-200 transition-colors">
                          ✓ In library
                        </span>
                      ) : (
                        <span className="shrink-0 text-[11px] font-medium text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity pr-2 cursor-pointer">
                          Split →
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {!hasSongs && results.length === 0 && !searching && (
          <p className="mt-8 text-center text-xs text-white/25 leading-relaxed">{timeHint}</p>
        )}
      </div>
    </div>
  )
}
