import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { venvPython, keyScript } from './env'
import { stemsDir, stemsFor, mixWavPath, loadSongs, patchSongKey } from './library'
import { acquireSeparation } from './separation-slots'
import { keyName, type KeyMode } from '../shared/keys'
import type { SongKey } from '../shared/types'

const TIMEOUT_MS = 120_000

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
            return done({
              detected: keyName(msg.tonic, msg.mode as KeyMode),
              confidence: Number(msg.confidence)
            })
          }
        } catch {
          // not a JSON line: ignore
        }
      }
      done({ detected: null })
    })
  })
}

const inflight = new Map<string, Promise<SongKey>>()

export function detectOnce(videoId: string, run = runKeyScript): Promise<SongKey> {
  const existing = inflight.get(videoId)
  if (existing) return existing
  const song = loadSongs().find((s) => s.videoId === videoId)
  if (!song) return Promise.resolve({ detected: null })
  // detection is attempted once per song: any stored key, even
  // { detected: null } (attempted and failed), is final
  if (song.key) return Promise.resolve(song.key)
  const job = (async (): Promise<SongKey> => {
    const release = await acquireSeparation()
    try {
      const result = await run(keyInputs(videoId, stemsFor(song)))
      // keep a user override that was set before detection finished; a
      // failure is stored too so it is not retried
      const current = loadSongs().find((s) => s.videoId === videoId)?.key
      const key: SongKey = current?.override ? { ...result, override: current.override } : result
      patchSongKey(videoId, key)
      return key
    } finally {
      release()
    }
  })().finally(() => inflight.delete(videoId))
  inflight.set(videoId, job)
  return job
}
