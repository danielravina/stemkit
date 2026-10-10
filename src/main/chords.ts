import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { BrowserWindow, dialog, app } from 'electron'
import { venvPython, chordsScript } from './env'
import { mixWavPath, songDir } from './library'
import type { JobEvent, ChordsDoc, ChordSources } from '../shared/types'

// ── helpers ───────────────────────────────────────────────────────────────

export function chordsJsonPath(videoId: string): string {
  return join(songDir(videoId), 'chords.json')
}
export function chordifyJsonPath(videoId: string): string {
  return join(songDir(videoId), 'chords_chordify.json')
}
export function hasChords(videoId: string): boolean {
  return existsSync(chordsJsonPath(videoId)) || existsSync(chordifyJsonPath(videoId))
}
export function readLocalDoc(videoId: string): ChordsDoc | null {
  try {
    const p = chordsJsonPath(videoId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const doc = JSON.parse(raw) as ChordsDoc
    if (!doc || (doc as any).version !== 1 || !Array.isArray(doc.chords)) return null
    return doc
  } catch { return null }
}
export function readChordifyDoc(videoId: string): ChordsDoc | null {
  try {
    const p = chordifyJsonPath(videoId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const doc = JSON.parse(raw) as ChordsDoc
    if (!doc || (doc as any).version !== 1 || !Array.isArray(doc.chords)) return null
    return doc
  } catch { return null }
}
export function readChords(videoId: string): ChordsDoc | null {
  // Prefer Chordify when present — it's subscription-accurate and guitar-friendly
  return readChordifyDoc(videoId) ?? readLocalDoc(videoId)
}
export function getChordSources(videoId: string): ChordSources {
  const local = readLocalDoc(videoId)
  const chordify = readChordifyDoc(videoId)
  const active = chordify ? 'chordify' : local ? 'local' : null
  return { local, chordify, active } as ChordSources
}

// ── analyzer ──────────────────────────────────────────────────────────────
// One analysis at a time — chords are short (~3s per song) so no queuing.

let activeProc: ChildProcess | null = null
let activeId: string | null = null

function send(ev: JobEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('job:event', ev)
}

export function isAnalyzing(): boolean {
  return activeProc !== null
}

export function cancelAnalysis(videoId?: string): void {
  if (!activeProc) return
  if (videoId && activeId !== videoId) return
  try {
    if (process.platform === 'win32' && activeProc.pid) {
      spawn('taskkill', ['/pid', String(activeProc.pid), '/T', '/F'])
    } else {
      activeProc.kill('SIGKILL')
    }
  } catch {}
}

export async function analyzeChords(videoId: string): Promise<{ started: boolean; error?: string }> {
  if (!existsSync(mixWavPath(videoId))) {
    return { started: false, error: 'No audio found for this track — split it first' }
  }
  if (activeProc) {
    return { started: false, error: 'Chord analysis is already running' }
  }
  const script = chordsScript()
  if (!existsSync(script)) {
    return { started: false, error: 'Chords engine not found (missing python/chords.py)' }
  }

  activeId = videoId
  send({ kind: 'progress', data: { videoId, stage: 'chords', pct: 0, message: 'Analyzing chords…' } })

  const outPath = chordsJsonPath(videoId)
  const args = ['-u', script, '--input', mixWavPath(videoId), '--out', outPath]

  return new Promise((resolve) => {
    const child = spawn(venvPython(), args, { env: { ...process.env } })
    activeProc = child

    let stderrTail = ''
    let stdoutTail = ''

    child.stdout?.on('data', (c: Buffer) => { stdoutTail = (stdoutTail + c.toString()).slice(-3000) })
    child.stderr?.on('data', (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-2000) })

    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    rl.on('line', (line: string) => {
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(line) } catch { return }
      if (parsed.type === 'progress') {
        const pct = Math.max(0, Math.min(100, Number(parsed.pct ?? 0)))
        const msg = typeof parsed.message === 'string' ? parsed.message : 'Analyzing…'
        send({ kind: 'progress', data: { videoId, stage: 'chords', pct, message: msg } })
      } else if (parsed.type === 'done') {
        send({ kind: 'progress', data: { videoId, stage: 'chords', pct: 95, message: 'Saving…' } })
      } else if (parsed.type === 'error') {
        stderrTail = String(parsed.message ?? stderrTail)
      }
    })

    child.on('error', (err) => {
      activeProc = null; activeId = null
      const m = err.message || String(err)
      send({ kind: 'failed', data: { videoId, message: `Chord analysis failed: ${m}` } })
      resolve({ started: false, error: m })
    })
    child.on('close', (code) => {
      activeProc = null; activeId = null
      try { rl.close() } catch {}
      if (code === 0) {
        // verify output
        if (!existsSync(outPath)) {
          send({ kind: 'failed', data: { videoId, message: 'Chord analysis finished but produced no output' } })
          resolve({ started: true })
          return
        }
        const doc = readChords(videoId)
        // emit done — triggers Player re-render via Chords doc read, not library reload
        send({ kind: 'progress', data: { videoId, stage: 'chords', pct: 100, message: `Chords ready (${doc?.chords.length ?? 0} segments)` } })
        // use a chords-specific done by piggybacking on JobDone with a dummy? Instead send a fresh event the UI listens to.
        // Simplest: send 'done' with a progress=100 then the renderer pulls via getChords.
        // Also broadcast a settings-like refresh by sending empty? Instead emit a dedicated chords:event.
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chords:done', { videoId })
        resolve({ started: true })
      } else {
        const detail = stderrTail.split('\n').filter(Boolean).slice(-2).join(' — ') || stdoutTail.split('\n').filter(Boolean).slice(-1).join('') || `exited ${code}`
        send({ kind: 'failed', data: { videoId, message: `Chord analysis failed: ${detail}` } })
        resolve({ started: true })
      }
    })
    // resolve started immediately so IPC can return
    resolve({ started: true })
  })
}

export async function exportChordsFile(videoId: string): Promise<{ saved: boolean; path?: string }> {
  const src = chordsJsonPath(videoId)
  if (!existsSync(src)) throw new Error('No chord data for this track')
  // Offer JSON + .txt (chord sheet) save
  const result = await dialog.showSaveDialog({
    title: 'Export chords',
    defaultPath: join(app.getPath('downloads'), `${videoId}_chords.json`),
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  })
  if (result.canceled || !result.filePath) return { saved: false }
  const dest = result.filePath
  // if txt, render a simple chord sheet
  if (dest.toLowerCase().endsWith('.txt')) {
    const doc = readChords(videoId)
    if (!doc) throw new Error('Corrupt chord data')
    const lines = doc.chords.map(c => `[${fmtTime(c.time)}] ${c.chord}`)
    writeFileSync(dest, lines.join('\n'), 'utf8')
    return { saved: true, path: dest }
  }
  // json: copy
  writeFileSync(dest, readFileSync(src))
  return { saved: true, path: dest }
}

export function deleteChordsFile(videoId: string): void {
  rmSync(chordsJsonPath(videoId), { force: true })
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2,'0')}`
}
