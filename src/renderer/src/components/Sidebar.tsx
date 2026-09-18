import type { Song } from '../../../shared/types'
import { fmtTime } from '../lib/format'
import { SongThumb } from '../lib/thumbs'
import { LogoMark, TrashIcon, PlusIcon, GearIcon } from './Icons'

interface Props {
  songs: Song[]
  activeId: string | null
  pending?: Record<string, { label: string; error?: boolean }>
  update?: { status: string; version?: string; pct?: number }
  appVersion?: string
  onSelect: (videoId: string) => void
  onDelete: (videoId: string) => void
  onAdd: () => void
  onInstallUpdate: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  songs,
  activeId,
  pending = {},
  update,
  appVersion,
  onSelect,
  onDelete,
  onAdd,
  onInstallUpdate,
  onOpenSettings
}: Props): React.ReactElement {
  return (
    <aside className="w-[264px] shrink-0 h-full flex flex-col border-r border-white/[0.07] bg-black/20">
      <div className="drag-region h-14 shrink-0 flex items-center gap-2.5 pl-[80px] pr-4">
        <LogoMark />
        <span className="font-semibold tracking-tight text-[15px]">StemKit</span>
        <button
          onClick={onOpenSettings}
          title="Settings"
          className="no-drag ml-auto w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors"
        >
          <GearIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-5 pb-2 pt-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">
          Library
        </span>
        <button
          onClick={onAdd}
          title="Add song"
          className="no-drag w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
        {songs.length === 0 && (
          <p className="px-2 pt-6 text-xs text-white/25 leading-relaxed text-center">
            No songs yet.
            <br />
            Paste a YouTube link to split your first track.
          </p>
        )}
        {songs.map((song) => {
          const active = song.videoId === activeId
          const pendingInfo = pending[song.videoId]
          const working = !!pendingInfo && !pendingInfo.error
          const failed = !!pendingInfo?.error
          return (
            <button
              key={song.videoId}
              onClick={() => onSelect(song.videoId)}
              className={`no-drag group w-full flex items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors ${
                active ? 'bg-white/10' : 'hover:bg-white/5'
              }`}
            >
              <span className="relative shrink-0">
                <SongThumb
                  videoId={song.videoId}
                  className={`w-12 h-[27px] rounded-md object-cover bg-white/5 block ${working ? 'opacity-70' : ''}`}
                  iconClassName="w-3.5 h-3.5 text-white/25"
                />
                {working && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[13px] truncate ${active ? 'text-white' : 'text-white/75'}`}>
                  {song.title || song.videoId}
                </span>
                {pendingInfo ? (
                  <span
                    className={`block text-[11px] mt-0.5 font-medium ${
                      failed ? 'text-rose-300' : 'text-violet-300'
                    }`}
                  >
                    {failed && <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 mr-1.5 align-middle" />}
                    {pendingInfo.label}
                  </span>
                ) : (
                  <span className="block text-[11px] text-white/35 font-mono mt-0.5">
                    {fmtTime(song.duration)}
                  </span>
                )}
              </span>
              {!working && (
                <span
                  role="button"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(song.videoId)
                  }}
                  className="no-drag opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-rose-300"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-white/[0.07] px-4 py-3 space-y-2">
        {update?.status === 'downloaded' && (
          <button
            onClick={onInstallUpdate}
            title="Install the downloaded update"
            className="no-drag w-full flex items-center justify-between rounded-lg bg-emerald-400/15 border border-emerald-400/30 px-3 py-2 text-[12px] text-emerald-200 hover:bg-emerald-400/25 transition-colors"
          >
            <span>v{update.version} ready</span>
            <span className="font-semibold">Restart ↻</span>
          </button>
        )}
        {update?.status === 'progress' && (
          <div className="flex items-center justify-between text-[11px] text-white/40 px-1">
            <span>Downloading update…</span>
            <span className="font-mono">{update.pct}%</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-[11px] text-white/35 truncate">
            {appVersion ? `v${appVersion} · ` : ''}Engine ready · 100% local
          </span>
        </div>
      </div>
    </aside>
  )
}
