import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, openSync, readSync, closeSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { userDataDir } from './env'
import { DEFAULT_STEMS, type Song, type StemPanMap, type StemId, type BeatGridData } from '../shared/types'

// drives both the file-dialog filter and the pre-flight extension check in
// startLocalJob; anything here is fair game for ffmpeg to decode
export const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'wma',
  'aiff',
  'aif',
  'alac',
  'webm'
]

function libraryFile(): string {
  return join(userDataDir(), 'library.json')
}

function songsRoot(): string {
  return join(userDataDir(), 'songs')
}

export function songDir(videoId: string): string {
  return join(songsRoot(), videoId)
}

export function stemsDir(videoId: string): string {
  return join(songDir(videoId), 'stems')
}

export function mixWavPath(videoId: string): string {
  return join(songDir(videoId), 'mix.wav')
}

export function rawDownloadPath(videoId: string): string {
  return join(songDir(videoId), 'raw.%(ext)s')
}

export function gridJsonPath(videoId: string): string {
  return join(songDir(videoId), 'grid.json')
}

export function loadBeatGrid(videoId: string): BeatGridData | null {
  try {
    const p = gridJsonPath(videoId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    return JSON.parse(raw) as BeatGridData
  } catch {
    return null
  }
}

export function saveBeatGrid(videoId: string, data: BeatGridData): void {
  try {
    const p = gridJsonPath(videoId)
    mkdirSync(songDir(videoId), { recursive: true })
    writeFileSync(p, JSON.stringify(data, null, 2))
  } catch {}
}

export function loadSongs(): Song[] {
  try {
    const raw = readFileSync(libraryFile(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data.songs) ? data.songs : []
  } catch {
    return []
  }
}

export function saveSongs(songs: Song[]): void {
  mkdirSync(userDataDir(), { recursive: true })
  writeFileSync(libraryFile(), JSON.stringify({ songs }, null, 2))
}

export function upsertSong(song: Song): Song[] {
  const songs = loadSongs().filter((s) => s.videoId !== song.videoId)
  songs.unshift(song)
  saveSongs(songs)
  return songs
}

export function removeSong(videoId: string): Song[] {
  const songs = loadSongs().filter((s) => s.videoId !== videoId)
  saveSongs(songs)
  rmSync(songDir(videoId), { recursive: true, force: true })
  return songs
}

export function stemsFor(song?: Song | null): string[] {
  return song?.stems?.length ? song.stems : DEFAULT_STEMS
}

function panSong(videoId: string): Song {
  const song = loadSongs().find((s) => s.videoId === videoId)
  if (!song || typeof videoId !== 'string' || !/^[\w-]+$/.test(videoId)) {
    throw new Error('Unknown song')
  }
  return song
}

function normalizePan(song: Song, value: unknown): StemPanMap {
  const pans: StemPanMap = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return pans
  const allowed = new Set<StemId>(['vocals', 'drums', 'bass', 'other', 'piano', 'guitar', 'click'])
  for (const id of stemsFor(song)) {
    if (!allowed.has(id as StemId)) continue
    const pan = (value as Record<string, unknown>)[id]
    if (typeof pan === 'number' && Number.isFinite(pan)) {
      pans[id as StemId] = Math.max(-1, Math.min(1, pan))
    }
  }
  if (allowed.has('click') && typeof (value as Record<string, unknown>)['click'] === 'number') {
    pans['click'] = Math.max(-1, Math.min(1, (value as Record<string, unknown>)['click'] as number))
  }
  return pans
}

export function loadStemPan(videoId: string): StemPanMap {
  const song = panSong(videoId)
  try {
    return normalizePan(song, JSON.parse(readFileSync(join(songDir(videoId), 'pan.json'), 'utf8')))
  } catch {
    return {}
  }
}

export function saveStemPan(videoId: string, pans: unknown): void {
  const song = panSong(videoId)
  // Do not recreate a deleted song directory for a late player save.
  writeFileSync(join(songDir(videoId), 'pan.json'), JSON.stringify(normalizePan(song, pans), null, 2))
}

export function stemsPresent(videoId: string, stems: string[]): boolean {
  const dir = stemsDir(videoId)
  if (!existsSync(dir)) return false
  return stems.every((name) => existsSync(join(dir, `${name}.wav`)))
}

// duration of a PCM wav by walking its RIFF chunks — used for local files,
// which have no yt-dlp metadata to read the length from. Returns 0 when the
// header can't be parsed (the player recovers from the decoded buffers)
export function wavDuration(path: string): number {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(4096)
    const read = readSync(fd, header, 0, header.length, 0)
    if (
      read < 44 ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      return 0
    }
    let sampleRate = 0
    let channels = 0
    let bits = 0
    let off = 12
    while (off + 8 <= read) {
      const id = header.toString('ascii', off, off + 4)
      const size = header.readUInt32LE(off + 4)
      if (id === 'fmt ' && off + 24 <= read) {
        channels = header.readUInt16LE(off + 10)
        sampleRate = header.readUInt32LE(off + 12)
        bits = header.readUInt16LE(off + 22)
      } else if (id === 'data') {
        if (!sampleRate || !channels || !bits || size === 0) return 0
        return Math.round(size / ((sampleRate * channels * bits) / 8))
      }
      if (size === 0) return 0
      off += 8 + size + (size % 2)
    }
    return 0
  } catch {
    return 0
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export async function stemBuffers(videoId: string, stems?: string[]): Promise<Record<string, Uint8Array>> {
  const song = loadSongs().find((s) => s.videoId === videoId)
  const list = new Set(stems ?? stemsFor(song))
  const dir = stemsDir(videoId)
  if (existsSync(join(dir, 'click.wav'))) {
    list.add('click')
  }
  const out: Record<string, Uint8Array> = {}
  // async parallel reads so ~400MB of WAV doesn't block the main process
  await Promise.all(
    Array.from(list).map(async (name) => {
      const file = join(dir, `${name}.wav`)
      if (!existsSync(file)) return
      out[name] = new Uint8Array(await readFile(file))
    })
  )
  return out
}
