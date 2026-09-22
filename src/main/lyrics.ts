import { spawn, execFile } from 'child_process'
import { createInterface } from 'readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { venvPython, modelsDir } from './env'
import { songDir, stemsDir } from './library'
import type { AppSettings } from '../shared/types'

export type LyricsModel = AppSettings['lyricsModel']

function sendEnvEvent(message: string, level: 'info' | 'error' | 'success' = 'info'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('env:event', { message, level })
  }
}

function runCapture(cmd: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function lyricsEngineDir(): string {
  return join(modelsDir(), 'whisper')
}

function readyMarkerPath(model: LyricsModel): string {
  return join(lyricsEngineDir(), `${model}.ready`)
}

function transcribeScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'transcribe.py')
  }
  return join(app.getAppPath(), 'python', 'transcribe.py')
}

export function lyricsPath(videoId: string): string {
  return join(songDir(videoId), 'lyrics.lrc')
}

function lyricsModelMarkerPath(videoId: string): string {
  return join(songDir(videoId), 'lyrics.model')
}

export function lyricsPresent(videoId: string): boolean {
  return existsSync(lyricsPath(videoId))
}

export function readLyrics(videoId: string): string | null {
  const p = lyricsPath(videoId)
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/* lazily installs the openai-whisper package into the venv, mirroring
   ensureEngineDeps() in env.ts for the roformer engine's extra deps —
   kept out of the base bootstrap so users who never enable lyrics don't
   pay for the extra download */
let lyricsDepsReady = false

export async function ensureLyricsDeps(): Promise<boolean> {
  if (lyricsDepsReady) return true
  try {
    await runCapture(venvPython(), ['-c', 'import whisper'], 20000)
    lyricsDepsReady = true
    return true
  } catch {}
  sendEnvEvent('Preparing lyrics components…')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(venvPython(), ['-m', 'pip', 'install', '-q', 'openai-whisper'], {
        env: { ...process.env }
      })
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip install failed (${code})`))
      )
      child.on('error', reject)
    })
    lyricsDepsReady = true
    sendEnvEvent('Lyrics components ready', 'success')
    return true
  } catch (err) {
    sendEnvEvent(
      `Lyrics components failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    return false
  }
}

/* downloads the chosen whisper checkpoint once, via whisper's own
   downloader (parsing its tqdm stderr for progress, same pattern as
   torchHubFetch() in env.ts for the htdemucs_ft download). A marker file
   is written on success so readiness survives app restarts without
   depending on whisper's internal cache file naming */
let lyricsEnginePromise: Promise<boolean> | null = null
const lyricsProgressListeners = new Set<(pct: number) => void>()

function whisperDownloadFetch(model: LyricsModel, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(lyricsEngineDir(), { recursive: true })
    const child = spawn(
      venvPython(),
      [
        '-c',
        `import whisper; whisper.load_model(${JSON.stringify(model)}, device="cpu", download_root=${JSON.stringify(lyricsEngineDir())})`
      ],
      { env: { ...process.env } }
    )
    let lastPct = 0
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000)
      for (const piece of chunk.toString().split(/[\r\n]/)) {
        const m = piece.match(/(\d{1,3})%/)
        if (!m) continue
        const pct = Math.min(99, parseInt(m[1], 10))
        if (pct <= lastPct) continue
        lastPct = pct
        sendEnvEvent(`lyrics engine: ${pct}%`)
        onProgress?.(pct)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(100)
        resolve()
      } else {
        reject(
          new Error(
            stderrTail.split('\n').filter(Boolean).slice(-1).join('') ||
              `lyrics engine download exited ${code}`
          )
        )
      }
    })
  })
}

export function ensureLyricsEngine(
  model: LyricsModel,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  if (onProgress) lyricsProgressListeners.add(onProgress)
  const detach = (result: boolean): boolean => {
    if (onProgress) lyricsProgressListeners.delete(onProgress)
    return result
  }
  if (existsSync(readyMarkerPath(model))) {
    detach(true)
    return Promise.resolve(true)
  }
  if (!lyricsEnginePromise) {
    lyricsEnginePromise = (async () => {
      sendEnvEvent(`Downloading the lyrics engine (${model}, one time)`)
      await whisperDownloadFetch(model, (pct) => {
        for (const listener of lyricsProgressListeners) listener(pct)
      })
      writeFileSync(readyMarkerPath(model), '')
      sendEnvEvent('Lyrics engine ready', 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Lyrics engine download failed: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        )
        return false
      })
      .finally(() => {
        lyricsEnginePromise = null
      })
  }
  return lyricsEnginePromise.then(detach)
}

export function lyricsEngineStatus(
  model: LyricsModel
): { lyricsDownloading: boolean; lyricsReady: boolean } {
  return {
    lyricsDownloading: lyricsEnginePromise !== null,
    lyricsReady: existsSync(readyMarkerPath(model))
  }
}

interface TranscribeResult {
  lines: number
  error?: string
}

function runTranscribe(
  vocalsPath: string,
  outDir: string,
  model: LyricsModel,
  device: string,
  onProgress?: (pct: number) => void
): Promise<TranscribeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      venvPython(),
      [
        transcribeScript(),
        '--input',
        vocalsPath,
        '--out',
        outDir,
        '--model',
        model,
        '--ckpt-dir',
        lyricsEngineDir(),
        '--device',
        device
      ],
      { env: { ...process.env } }
    )
    let lines = 0
    let scriptError: string | undefined
    let lastPct = 0
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line)
        } catch {
          return
        }
        if (parsed.type === 'progress') {
          const pct = Math.max(lastPct, Number(parsed.pct ?? 0))
          lastPct = pct
          onProgress?.(pct)
        } else if (parsed.type === 'error') {
          scriptError = String(parsed.message)
        } else if (parsed.type === 'done') {
          lines = Number(parsed.lines ?? 0)
        }
      })
    }
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ lines, error: scriptError })
      } else {
        reject(
          new Error(
            scriptError ||
              stderrTail.split('\n').filter(Boolean).slice(-2).join(' — ') ||
              `transcribe.py exited with code ${code}`
          )
        )
      }
    })
  })
}

/* called from pipeline.ts right after a job's stem separation finishes.
   Purely additive: any failure here is logged as an env event but never
   throws, so it can never fail the containing split job. Caching is
   decoupled from the stem cache in library.ts — switching the lyrics
   model re-transcribes without re-splitting the stems */
export async function maybeExtractLyrics(
  videoId: string,
  settings: AppSettings,
  device: string,
  onProgress: (pct: number, message?: string) => void
): Promise<void> {
  if (!settings.extractLyrics) return
  const vocalsPath = join(stemsDir(videoId), 'vocals.wav')
  if (!existsSync(vocalsPath)) return

  try {
    const model = settings.lyricsModel
    const markerPath = lyricsModelMarkerPath(videoId)
    const existingModel = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null
    if (lyricsPresent(videoId) && existingModel === model) return

    if (!(await ensureLyricsDeps())) {
      onProgress(0, 'Could not prepare the lyrics engine components')
      return
    }
    const engineReady = await ensureLyricsEngine(model, (pct) =>
      onProgress(Math.round(pct * 0.3), `Downloading lyrics engine: ${pct}%`)
    )
    if (!engineReady) {
      onProgress(0, 'Could not download the lyrics engine')
      return
    }
    onProgress(30, 'Extracting lyrics')
    const result = await runTranscribe(vocalsPath, songDir(videoId), model, device, (pct) =>
      onProgress(30 + Math.round(pct * 0.7))
    )
    if (result.error) {
      sendEnvEvent(`Lyrics extraction failed: ${result.error}`, 'error')
      return
    }
    writeFileSync(markerPath, model)
    if (result.lines === 0) {
      onProgress(100, 'No lyrics found')
    } else {
      onProgress(100, 'Lyrics ready')
    }
  } catch (err) {
    sendEnvEvent(
      `Lyrics extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
  }
}

/* used by src/main/smoke.ts: runs the whole lyrics pipeline (deps, engine
   download, transcription) against an arbitrary wav and reports whether it
   ran cleanly and how many lines it produced — the smoke test asserts 0
   lines on a pure sine-tone mix, proving the hallucination filter works */
export async function smokeTestTranscribe(
  vocalsPath: string,
  outDir: string
): Promise<{ ok: boolean; lines: number; error?: string }> {
  if (!(await ensureLyricsDeps())) return { ok: false, lines: 0, error: 'lyrics deps install failed' }
  if (!(await ensureLyricsEngine('small'))) {
    return { ok: false, lines: 0, error: 'lyrics engine download failed' }
  }
  try {
    const result = await runTranscribe(vocalsPath, outDir, 'small', 'cpu')
    return { ok: true, lines: result.lines }
  } catch (err) {
    return { ok: false, lines: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
