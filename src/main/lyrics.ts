import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { app, dialog, BrowserWindow } from 'electron'
import { venvYtDlp, ytDlpRuntimeArgs } from './env'
import { songDir, loadSongs } from './library'
import type { LyricsDoc, LyricLine } from '../shared/types'

export function lyricsJsonPath(videoId: string): string {
  return join(songDir(videoId), 'lyrics.json')
}
export function hasLyrics(videoId: string): boolean {
  return existsSync(lyricsJsonPath(videoId))
}
export function readLyrics(videoId: string): LyricsDoc | null {
  try {
    const p = lyricsJsonPath(videoId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const doc = JSON.parse(raw) as LyricsDoc
    if (!doc || (doc as any).version !== 1 || !Array.isArray(doc.lines)) return null
    return doc
  } catch { return null }
}
export function deleteLyricsFile(videoId: string): void {
  rmSync(lyricsJsonPath(videoId), { force: true })
  // also clean any stray vtt/srt leftovers we may have produced
  try {
    const dir = songDir(videoId)
    for (const f of readdirSync(dir)) {
      if (f.startsWith('lyrics.') && (f.endsWith('.vtt') || f.endsWith('.srt') || f.endsWith('.lrc'))) {
        rmSync(join(dir, f), { force: true })
      }
    }
  } catch {}
}

function sendLyricsDone(videoId: string): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('lyrics:done', { videoId })
}

// ── parsers ────────────────────────────────────────────────────────────

function parseTimeToSec(s: string): number {
  // 00:01:23.456 or 00:01:23,456 or 01:23.45
  const t = s.replace(',', '.').trim()
  const parts = t.split(':').map(p => p.trim())
  let sec = 0
  if (parts.length === 3) sec = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2])
  else if (parts.length === 2) sec = parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
  else sec = parseFloat(parts[0])
  return isNaN(sec) ? 0 : sec
}

export function parseVtt(text: string): LyricLine[] {
  const lines: LyricLine[] = []
  // strip BOM + WEBVTT header
  const norm = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const blocks = norm.split(/\n\s*\n/)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed || trimmed.startsWith('WEBVTT') || trimmed.startsWith('NOTE') || trimmed.startsWith('STYLE')) continue
    const ls = trimmed.split('\n').map(l => l.trim()).filter(Boolean)
    if (ls.length === 0) continue
    // cue timing line contains -->
    let timeIdx = ls.findIndex(l => l.includes('-->'))
    if (timeIdx === -1) continue
    const timing = ls[timeIdx]
    const m = timing.match(/([\d:.]+)\s*-->\s*([\d:.]+)/)
    if (!m) continue
    const start = parseTimeToSec(m[1])
    const end = parseTimeToSec(m[2])
    const dur = Math.max(0.2, end - start)
    const cueText = ls.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!cueText) continue
    lines.push({ time: Math.round(start * 1000) / 1000, duration: Math.round(dur * 1000) / 1000, text: cueText })
  }
  // merge very close duplicates? keep as is for now
  return lines
}

export function parseSrt(text: string): LyricLine[] {
  // almost identical to vtt but with comma decimals and index numbers
  const norm = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const blocks = norm.split(/\n\s*\n/)
  const out: LyricLine[] = []
  for (const block of blocks) {
    const ls = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (ls.length < 2) continue
    // first line may be index number
    let idx = 0
    if (/^\d+$/.test(ls[0])) idx = 1
    const timing = ls[idx]
    if (!timing || !timing.includes('-->')) continue
    const m = timing.match(/([\d:, .]+)\s*-->\s*([\d:, .]+)/)
    if (!m) continue
    const start = parseTimeToSec(m[1])
    const end = parseTimeToSec(m[2])
    const dur = Math.max(0.2, end - start)
    const cue = ls.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!cue) continue
    out.push({ time: Math.round(start * 1000) / 1000, duration: Math.round(dur * 1000) / 1000, text: cue })
  }
  return out
}

export function parseLrc(text: string, fallbackDuration = 180): LyricLine[] {
  const norm = text.replace(/\r\n/g, '\n')
  const raw: { t: number; txt: string }[] = []
  const timeRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const line of norm.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // skip metadata like [ti:...] [ar:...]
    if (/^\[(ti|ar|al|by|offset):/i.test(trimmed)) continue
    const matches = Array.from(trimmed.matchAll(timeRe))
    if (matches.length === 0) continue
    const txt = trimmed.replace(timeRe, '').trim()
    if (!txt) continue
    for (const m of matches) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const fracStr = m[3] ?? '0'
      let frac = 0
      if (fracStr.length === 3) frac = parseInt(fracStr, 10) / 1000
      else if (fracStr.length === 2) frac = parseInt(fracStr, 10) / 100
      else if (fracStr.length === 1) frac = parseInt(fracStr, 10) / 10
      const t = min * 60 + sec + frac
      raw.push({ t, txt })
    }
  }
  raw.sort((a, b) => a.t - b.t)
  const lines: LyricLine[] = []
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i]
    const nextT = i + 1 < raw.length ? raw[i + 1].t : fallbackDuration
    const dur = Math.max(0.6, Math.min(6, nextT - cur.t))
    lines.push({ time: Math.round(cur.t * 1000) / 1000, duration: Math.round(dur * 1000) / 1000, text: cur.txt })
  }
  return lines
}

function parseTxtUntimed(text: string, duration: number): LyricLine[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
  if (raw.length === 0) return []
  const per = duration > 0 ? duration / raw.length : 3
  return raw.map((t, i) => ({
    time: Math.round(i * per * 1000) / 1000,
    duration: Math.round(Math.min(per, 6) * 1000) / 1000,
    text: t
  }))
}

function detectAndParse(text: string, fallbackDuration: number, filenameHint = ''): LyricLine[] {
  const lower = text.slice(0, 800).toLowerCase()
  const hint = filenameHint.toLowerCase()
  if (hint.endsWith('.lrc') || lower.includes('[00:') || lower.includes('[01:')) {
    const lrc = parseLrc(text, fallbackDuration)
    if (lrc.length > 0) return lrc
  }
  if (lower.includes('webvtt') || hint.endsWith('.vtt')) {
    const v = parseVtt(text)
    if (v.length > 0) return v
  }
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2}[.,]/.test(text) || hint.endsWith('.srt')) {
    const s = parseSrt(text)
    if (s.length > 0) return s
  }
  // try all in order
  let p = parseVtt(text)
  if (p.length > 0) return p
  p = parseSrt(text)
  if (p.length > 0) return p
  p = parseLrc(text, fallbackDuration)
  if (p.length > 0) return p
  // last resort: plain txt
  return parseTxtUntimed(text, fallbackDuration)
}

// ── fetch from YouTube via yt-dlp ───────────────────────────────────────

export async function fetchLyricsForSong(videoId: string, songDuration: number): Promise<LyricsDoc> {
  const song = loadSongs().find(s => s.videoId === videoId)
  if (!song) throw new Error('Song not found — split it first')
  if (song.source === 'local') throw new Error('Local files have no YouTube captions — import an .lrc/.srt/.vtt file instead')
  // quick id check
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) throw new Error('Not a YouTube song — import lyrics file instead')

  const dir = songDir(videoId)
  mkdirSync(dir, { recursive: true })

  // Clean any previous temp lyrics artifacts to avoid stale reads
  for (const f of readdirSync(dir)) {
    if (f.startsWith('lyrics.')) {
      try { rmSync(join(dir, f), { force: true }) } catch {}
    }
  }

  const outTemplate = join(dir, 'lyrics.%(ext)s')
  const url = `https://www.youtube.com/watch?v=${videoId}`

  const args = [
    ...ytDlpRuntimeArgs(),
    '--skip-download',
    '--write-auto-subs',
    '--write-subs',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'vtt/srt/best',
    '--no-playlist',
    '-o', outTemplate,
    url
  ]

  const ytDlp = venvYtDlp()
  if (!existsSync(ytDlp)) throw new Error('Engine not ready — yt-dlp not found')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ytDlp, args, { env: { ...process.env } })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-3000) })
    child.stdout?.on('data', () => {})
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else {
        const msg = stderr.split('\n').filter(Boolean).slice(-2).join(' — ') || `yt-dlp exited ${code}`
        reject(new Error(msg))
      }
    })
  })

  // find the produced file
  const produced = readdirSync(dir).filter(f => f.startsWith('lyrics.') && (f.endsWith('.vtt') || f.endsWith('.srt')))
  if (produced.length === 0) {
    throw new Error('No English captions found for this video — the uploader may have captions disabled. Import an .lrc/.srt file instead.')
  }
  // prefer vtt
  produced.sort((a, b) => (a.endsWith('.vtt') ? -1 : 1))
  const chosen = join(dir, produced[0])
  const text = readFileSync(chosen, 'utf8')
  const lines = detectAndParse(text, songDuration, chosen)
  if (lines.length === 0) throw new Error('Captions file was empty — try importing a file')

  const doc: LyricsDoc = {
    version: 1 as const,
    duration: songDuration,
    source: 'youtube' as const,
    language: 'en',
    lines,
    generatedAt: Date.now()
  }
  writeFileSync(lyricsJsonPath(videoId), JSON.stringify(doc, null, 2), 'utf8')
  // cleanup raw temp
  for (const f of produced) try { rmSync(join(dir, f), { force: true }) } catch {}
  sendLyricsDone(videoId)
  return doc
}

// ── import ────────────────────────────────────────────────────────────────

export async function exportLyricsFile(videoId: string): Promise<{ saved: boolean; path?: string }> {
  const doc = readLyrics(videoId)
  if (!doc) throw new Error('No lyrics for this track')
  const song = loadSongs().find(s => s.videoId === videoId)
  const base = (song?.title ?? videoId).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
  const result = await dialog.showSaveDialog({
    title: 'Export lyrics',
    defaultPath: join(app.getPath('downloads'), `${base} - lyrics.lrc`),
    filters: [
      { name: 'LRC lyrics', extensions: ['lrc'] },
      { name: 'SRT subtitles', extensions: ['srt'] },
      { name: 'VTT captions', extensions: ['vtt'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })
  if (result.canceled || !result.filePath) return { saved: false }
  const dest = result.filePath
  const lower = dest.toLowerCase()
  if (lower.endsWith('.json')) {
    writeFileSync(dest, JSON.stringify(doc, null, 2), 'utf8')
  } else if (lower.endsWith('.srt')) {
    const srt = doc.lines.map((l, i) => {
      const s = l.time
      const e = l.time + l.duration
      const fmt = (t: number): string => {
        const h = Math.floor(t / 3600)
        const m = Math.floor((t % 3600) / 60)
        const sec = Math.floor(t % 60)
        const ms = Math.round((t - Math.floor(t)) * 1000)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`
      }
      return `${i + 1}\n${fmt(s)} --> ${fmt(e)}\n${l.text}\n`
    }).join('\n')
    writeFileSync(dest, srt, 'utf8')
  } else if (lower.endsWith('.vtt')) {
    const vtt = ['WEBVTT', ''].concat(doc.lines.map(l => {
      const fmt = (t: number): string => {
        const m = Math.floor(t / 60)
        const s = Math.floor(t % 60)
        const ms = Math.round((t - Math.floor(t)) * 1000)
        const frac = String(ms).padStart(3, '0')
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`
      }
      return `${fmt(l.time)} --> ${fmt(l.time + l.duration)}\n${l.text}\n`
    })).join('\n')
    writeFileSync(dest, vtt, 'utf8')
  } else {
    // default lrc
    const lrc = doc.lines.map(l => {
      const m = Math.floor(l.time / 60)
      const s = Math.floor(l.time % 60)
      const cs = Math.round((l.time - Math.floor(l.time)) * 100)
      return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}]${l.text}`
    }).join('\n')
    writeFileSync(dest, lrc, 'utf8')
  }
  return { saved: true, path: dest }
}

export async function importLyricsFile(videoId: string, songDuration: number): Promise<LyricsDoc> {
  const song = loadSongs().find(s => s.videoId === videoId)
  if (!song) throw new Error('Song not found — split it first')
  const result = await dialog.showOpenDialog({
    title: 'Import lyrics (LRC / SRT / VTT / TXT)',
    properties: ['openFile'],
    filters: [
      { name: 'Lyrics', extensions: ['lrc', 'srt', 'vtt', 'txt', 'json'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePaths[0]) throw new Error('Import cancelled')
  const file = result.filePaths[0]
  const base = basename(file)
  const text = readFileSync(file, 'utf8')
  let lines: LyricLine[] = []
  // allow re-importing a previously exported lyrics.json
  if (file.toLowerCase().endsWith('.json')) {
    try {
      const j = JSON.parse(text)
      if (j && (j as any).version === 1 && Array.isArray((j as any).lines)) {
        lines = (j as LyricsDoc).lines
      } else if (Array.isArray(j)) {
        // maybe raw chordify style? shouldn't happen
        throw new Error('JSON is not a lyrics doc')
      } else {
        lines = detectAndParse(text, songDuration, base)
      }
    } catch {
      lines = detectAndParse(text, songDuration, base)
    }
  } else {
    lines = detectAndParse(text, songDuration, base)
  }
  if (lines.length === 0) throw new Error('Could not parse any lyric lines from that file')
  const doc: LyricsDoc = {
    version: 1,
    duration: songDuration,
    source: 'imported' as const,
    language: 'en',
    lines,
    generatedAt: Date.now()
  }
  writeFileSync(lyricsJsonPath(videoId), JSON.stringify(doc, null, 2), 'utf8')
  sendLyricsDone(videoId)
  return doc
}
