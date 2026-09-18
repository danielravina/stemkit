import { useEffect, useState } from 'react'
import { isLocalId } from '../../../shared/local'
import { SpeakerIcon } from '../components/Icons'

// library thumbnails resolve through the local cache in the main process
// (userData/thumbs). Setting changes re-resolve: hideVideo on/off changes
// whether missing thumbs may still be fetched online
const memo = new Map<string, Promise<string | null>>()

function getThumbCached(videoId: string): Promise<string | null> {
  let p = memo.get(videoId)
  if (!p) {
    p = window.stemkit.getThumb(videoId).catch(() => null)
    memo.set(videoId, p)
  }
  return p
}

// one IPC subscription per channel shared by every Thumb on the page —
// per-component subscriptions blow past Electron's 10-listener cap once
// the sidebar holds a handful of songs. An empty videoId means "re-check
// everything" (settings flip); otherwise only that video's thumb changed
type RecheckListener = (videoId: string) => void
const listeners = new Set<RecheckListener>()
let subscribed = false

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.stemkit.onSettingsChange(() => {
    memo.clear()
    listeners.forEach((l) => l(''))
  })
  // optional so a stale preload (renderer hot-reloaded, window not) can't
  // take the whole app down with a TypeError
  window.stemkit.onThumbCached?.((id) => {
    memo.delete(id)
    listeners.forEach((l) => l(id))
  })
}

export function useThumb(videoId: string): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const resolve = (): void => {
      void getThumbCached(videoId).then((url) => {
        if (alive) setSrc(url)
      })
    }
    resolve()
    ensureSubscribed()
    const listener: RecheckListener = (id) => {
      if (id && id !== videoId) return
      resolve()
    }
    listeners.add(listener)
    return () => {
      alive = false
      listeners.delete(listener)
    }
  }, [videoId])
  return src
}

export function Thumb({ videoId, className }: { videoId: string; className: string }): React.ReactElement {
  const src = useThumb(videoId)
  if (!src) return <span className={className} />
  return <img src={src} alt="" className={className} draggable={false} />
}

// song artwork slot: YouTube ids resolve through the thumbnail cache, local
// files get a speaker badge (there is nothing to fetch for them)
export function SongThumb({
  videoId,
  className,
  iconClassName = 'w-1/2 h-1/2 text-white/25'
}: {
  videoId: string
  className: string
  iconClassName?: string
}): React.ReactElement {
  if (isLocalId(videoId)) {
    return (
      <span className={`${className} flex items-center justify-center`}>
        <SpeakerIcon className={iconClassName} />
      </span>
    )
  }
  return <Thumb videoId={videoId} className={className} />
}
