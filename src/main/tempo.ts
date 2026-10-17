import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { loadSongs, mixWavPath, songDir } from './library'
import { ensureTempoDeps, tempoScript, userDataDir, venvPython } from './env'
import type { TempoAnalysis, TempoPoint } from '../shared/types'

const VERSION = 'librosa-0.11-pulse-5'
const jobs = new Map<string, { cancelled: boolean; child?: ChildProcess }>()

function validatePoints(value: unknown): TempoPoint[] {
  if (!Array.isArray(value)) throw new Error('Invalid tempo analysis')
  let previous = -1
  for (const point of value) {
    if (!point || !Number.isFinite(point.start) || point.start < 0 || point.start <= previous ||
        !Number.isFinite(point.bpm) || point.bpm < 30 || point.bpm > 300) throw new Error('Invalid tempo analysis')
    previous = point.start
  }
  if (value.length && value[0].start !== 0) throw new Error('Invalid tempo analysis')
  return value.map(({ start, bpm }) => ({ start, bpm }))
}

function validateAnalysis(value: unknown): TempoAnalysis {
  if (!value || typeof value !== 'object') throw new Error('Invalid tempo analysis')
  const { points, beats } = value as TempoAnalysis
  const validated = validatePoints(points)
  if (!Array.isArray(beats)) throw new Error('Invalid tempo analysis')
  let previous = -1
  for (const beat of beats) {
    if (!Number.isFinite(beat) || beat < 0 || beat <= previous) throw new Error('Invalid tempo analysis')
    previous = beat
  }
  if (!validated.length && beats.length) throw new Error('Invalid tempo analysis')
  return { points: validated, beats }
}

export function cancelSongTempo(requestId: string, owner: number): void {
  const job = jobs.get(`${owner}:${requestId}`)
  if (!job) return
  job.cancelled = true
  job.child?.kill()
}

export async function analyzeSongTempo(videoId: string, requestId: string, owner: number): Promise<TempoAnalysis> {
  if (typeof videoId !== 'string' || !/^[\w-]+$/.test(videoId) || !loadSongs().some(song => song.videoId === videoId)) {
    throw new Error('Unknown song')
  }
  return analyzeStoredMix(videoId, requestId, owner)
}

// Imports own a validated song directory before its library entry is committed.
export function analyzeImportedTempo(videoId: string): Promise<TempoAnalysis> {
  return analyzeStoredMix(videoId, `import-${videoId}`, -1)
}

export function cancelImportedTempo(videoId: string): void {
  cancelSongTempo(`import-${videoId}`, -1)
}

async function analyzeStoredMix(videoId: string, requestId: string, owner: number): Promise<TempoAnalysis> {
  if (typeof videoId !== 'string' || !/^[\w-]+$/.test(videoId)) throw new Error('Unknown song')
  if (typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) throw new Error('Invalid analysis request')
  const source = mixWavPath(videoId)
  if (!existsSync(source)) throw new Error('Original mix is missing. Enter BPM manually or turn count-in Off.')
  const { size, mtimeMs } = statSync(source)
  const cache = join(songDir(videoId), 'tempo-analysis.json')
  try {
    const saved = JSON.parse(readFileSync(cache, 'utf8'))
    if (saved.version === VERSION && saved.size === size && saved.mtimeMs === mtimeMs) return validateAnalysis(saved)
  } catch {}
  const key = `${owner}:${requestId}`
  if (jobs.has(key) && !jobs.get(key)!.cancelled) throw new Error('Tempo analysis is already running')
  const job: { cancelled: boolean; child?: ChildProcess } = { cancelled: false }
  jobs.set(key, job)
  try {
    await ensureTempoDeps()
    if (job.cancelled) throw new Error('Tempo analysis cancelled')
    const analysis = await new Promise<TempoAnalysis>((resolve, reject) => {
      const child = spawn(venvPython(), [tempoScript(), '--input', source], {
        // Small FFT/mel batches run faster without competing math-library threads.
        env: { ...process.env, NUMBA_CACHE_DIR: join(userDataDir(), 'tempo-numba'),
          OPENBLAS_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
        windowsHide: true
      })
      job.child = child
      let output = ''
      let error = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Tempo analysis took too long. Enter BPM manually or turn count-in Off.'))
      }, 120000)
      child.stdout.on('data', chunk => {
        output += chunk.toString()
        if (output.length > 1024 * 1024) { child.kill(); reject(new Error('Invalid tempo analysis')) }
      })
      child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-2000) })
      child.on('error', err => { clearTimeout(timer); reject(err) })
      child.on('close', code => {
        clearTimeout(timer)
        if (job.cancelled) { reject(new Error('Tempo analysis cancelled')); return }
        if (code !== 0) { reject(new Error(`Tempo analysis failed. Enter BPM manually or turn count-in Off. ${error.slice(-300)}`)); return }
        try { resolve(validateAnalysis(JSON.parse(output))) } catch { reject(new Error('Invalid tempo analysis')) }
      })
    })
    if (job.cancelled) throw new Error('Tempo analysis cancelled')
    // Cache only while the song and its original audio still exist and match this analysis.
    if (existsSync(source)) {
      const current = statSync(source)
      if (current.size === size && current.mtimeMs === mtimeMs) {
        try { writeFileSync(cache, JSON.stringify({ version: VERSION, size, mtimeMs, ...analysis })) } catch {}
      }
    }
    return analysis
  } finally {
    if (jobs.get(key) === job) jobs.delete(key)
  }
}
