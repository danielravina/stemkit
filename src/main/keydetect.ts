import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { venvPython, keyScript } from './env'
import { stemsDir, stemsFor, mixWavPath, loadSongs, patchSongKey } from './library'
import { acquireSeparation } from './separation-slots'
import { keyName, type KeyMode } from '../shared/keys'
import type { SongKey } from '../shared/types'

const TIMEOUT_MS = 120_000

// bump when python/key.py changes what it detects: songs keep a detected key
// for good, so without this they would keep showing the old algorithm's key
// (2: chroma no longer biased by the FFT bin layout)
export const KEY_VERSION = 2

export function stamped(key: SongKey): SongKey {
  return { ...key, version: KEY_VERSION }
}

// only a key the old algorithm detected is redone; a stored failure stays
// final (it means no venv or no audio, not a wrong answer)
function isStale(key: SongKey): boolean {
  return key.detected !== null && (key.version ?? 1) < KEY_VERSION
}

// drums carry no pitch and only blur the chroma, so they are left out; with
// nothing else on disk the full mix is the fallback
export function keyInputs(videoId: string, stems: string[]): string[] {
  const files = stems
    .filter((s) => s !== 'drums')
    .map((s) => join(stemsDir(videoId), `${s}.wav`))
    .filter((f) => existsSync(f))
  return files.length ? files : [mixWavPath(videoId)]
}

export function runKeyScript(inputs: string[]): Promise<SongKey> {
  return new Promise((resolve) => {
    let settled = false
    const done = (key: SongKey): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(key)
    }
    let child: ReturnType<typeof spawn> | undefined
    const timer = setTimeout(() => {
      child?.kill()
      done({ detected: null })
    }, TIMEOUT_MS)
    try {
      child = spawn(venvPython(), [keyScript(), ...inputs.flatMap((i) => ['--input', i])], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return done({ detected: null })
    }
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => done({ detected: null }))
    child.on('close', (code) => {
      if (code !== 0) return done({ detected: null })
      for (const line of out.split('\n')) {
        try {
          const msg = JSON.parse(line)
          if (
            msg?.type === 'key' &&
            Number.isInteger(msg.tonic) &&
            (msg.mode === 'major' || msg.mode === 'minor')
          ) {
            return done({ detected: keyName(msg.tonic, msg.mode as KeyMode) })
          }
        } catch {
          // not a JSON line: ignore
        }
      }
      done({ detected: null })
    })
  })
}

// a fresh detection must not drop the user's manual correction
export function withOverride(key: SongKey, previous: SongKey | undefined): SongKey {
  return previous?.override ? { ...key, override: previous.override } : key
}

const inflight = new Map<string, Promise<SongKey>>()

// force: the user asked to retry (a stored failure is otherwise final, so a
// missing venv does not cost a 2-minute timeout on every song open)
export function detectOnce(
  videoId: string,
  run = runKeyScript,
  { force = false }: { force?: boolean } = {}
): Promise<SongKey> {
  const existing = inflight.get(videoId)
  if (existing) return existing
  const song = loadSongs().find((s) => s.videoId === videoId)
  if (!song) return Promise.resolve({ detected: null })
  // detection runs once per song on its own: any stored key, even
  // { detected: null } (attempted and failed), is final unless forced
  if (song.key && !force && !isStale(song.key)) return Promise.resolve(song.key)
  const job = (async (): Promise<SongKey> => {
    const release = await acquireSeparation()
    try {
      const result = await run(keyInputs(videoId, stemsFor(song)))
      // keep a user override that was set before detection finished; a
      // failure is stored too so it is not retried automatically
      const current = loadSongs().find((s) => s.videoId === videoId)?.key
      const key = withOverride(stamped(result), current)
      patchSongKey(videoId, key)
      return key
    } finally {
      release()
    }
  })().finally(() => inflight.delete(videoId))
  inflight.set(videoId, job)
  return job
}
