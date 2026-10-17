export type YTState =
  | 'unstarted'
  | 'ended'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'cued'

const STATE_MAP: Record<number, YTState> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued'
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: Record<string, unknown>
      ) => YTPlayerLike
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

interface YTPlayerLike {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlaybackRate(): number
  getAvailablePlaybackRates(): number[]
  setPlaybackRate(rate: number): void
  mute(): void
  destroy(): void
  loadVideoById(id: string): void
}

let apiPromise: Promise<void> | null = null

export function loadYTApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve()
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      resolve()
    }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })
  return apiPromise
}

export class YouTubeHost {
  private player: YTPlayerLike | null = null
  private stateCb: ((s: YTState) => void) | null = null

  async mount(
    container: HTMLElement,
    videoId: string,
    onState: (s: YTState) => void
  ): Promise<void> {
    this.stateCb = onState
    await loadYTApi()
    const inner = document.createElement('div')
    container.appendChild(inner)
    this.player = await new Promise<YTPlayerLike>((resolve) => {
      const p = new window.YT!.Player(inner, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,
          disablekb: 1,
          rel: 0,
          playsinline: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            p.mute()
            resolve(p)
          },
          onStateChange: (e: { data: number }) =>
            this.stateCb?.(STATE_MAP[e.data] ?? 'paused')
        }
      })
    })
  }

  play(): void {
    this.player?.playVideo()
  }

  pause(): void {
    this.player?.pauseVideo()
  }

  seek(t: number): void {
    this.player?.seekTo(Math.max(0, t), true)
  }

  time(): number {
    return this.player?.getCurrentTime() ?? 0
  }

  duration(): number {
    return this.player?.getDuration() ?? 0
  }

  setRate(rate: number): void {
    // YouTube offers discrete rates; source audio remains the timing authority.
    const available = this.player?.getAvailablePlaybackRates() ?? []
    if (!available.length) return
    const nearest = available.reduce((best, value) => Math.abs(value - rate) < Math.abs(best - rate) ? value : best)
    this.player?.setPlaybackRate(nearest)
  }

  rate(): number {
    return this.player?.getPlaybackRate() ?? 1
  }

  destroy(): void {
    try {
      this.player?.destroy()
    } catch {}
    this.player = null
    this.stateCb = null
  }
}
