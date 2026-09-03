import { app, net } from 'electron'
import type { LyricsResult } from '../shared/types'

/* lyrics lookup via lrclib.net (free, no API key). Runs in the main process
   because the renderer CSP restricts connect-src to 'self'. Results are
   cached per video for the session; a miss is cached too so we never hammer
   the API for songs that have no lyrics */

interface LrcLibItem {
  trackName?: string
  artistName?: string
  duration?: number
  instrumental?: boolean
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

const cache = new Map<string, LyricsResult>()

const NONE: LyricsResult = { found: false, synced: null, plain: null }

/* YouTube titles carry noise like "(Official Video)" or "[4K Remaster]" that
   ruins the search; strip bracketed segments containing such words */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[([{][^)\]}]*[)\]}]/g, (m) =>
      /official|video|audio|lyric|visuali[sz]er|remaster|live|explicit|clean|hd|4k|mv|m\/v/i.test(m)
        ? ' '
        : m
    )
    .replace(/\b(official\s+(music\s+)?video|official\s+audio|lyrics?\s+video|full\s+video)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function search(title: string, duration: number): Promise<LyricsResult> {
  const q = cleanTitle(title)
  if (!q) return NONE
  const res = await net.fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
    headers: {
      'User-Agent': `StemKit/${app.getVersion()} (https://github.com/danielravina/stemkit)`
    },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) return NONE
  const items = (await res.json()) as LrcLibItem[]
  const usable = (Array.isArray(items) ? items : []).filter(
    (i) => !i.instrumental && ((i.syncedLyrics ?? '').trim() || (i.plainLyrics ?? '').trim())
  )
  if (usable.length === 0) return NONE

  // prefer synced lyrics, then the closest runtime to our track
  const score = (i: LrcLibItem): number => {
    let s = (i.syncedLyrics ?? '').trim() ? 10 : 0
    if (duration > 0 && typeof i.duration === 'number') {
      const diff = Math.abs(i.duration - duration)
      if (diff <= 3) s += 6
      else if (diff <= 10) s += 3
      else if (diff > 30) s -= 6
    }
    return s
  }
  usable.sort((a, b) => score(b) - score(a))
  const best = usable[0]
  return {
    found: true,
    synced: (best.syncedLyrics ?? '').trim() || null,
    plain: (best.plainLyrics ?? '').trim() || null
  }
}

export async function fetchLyrics(
  videoId: string,
  title: string,
  duration: number
): Promise<LyricsResult> {
  const hit = cache.get(videoId)
  if (hit) return hit
  const result = await search(title, duration).catch(() => NONE)
  cache.set(videoId, result)
  return result
}
