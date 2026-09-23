import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, normalize, extname } from 'path'
import { existsSync, copyFileSync, mkdirSync, createReadStream, statSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { AppSettings } from '../shared/types'
import {
  detectTools,
  bootstrap,
  updateYtDlp,
  refreshReady,
  ensureVocalsEngine,
  ensureFtWeights,
  ensureGpuEngine,
  detectGpuVendor,
  gpuVendorInfo,
  applyGpuOverride,
  hasGpuAcceleration,
  gpuAccelerationInfo,
  engineStatus,
  getStatus
} from './env'
import { loadSettings, saveSettings } from './settings'
import { loadSongs, removeSong, stemBuffers, stemsDir, stemsFor, mixWavPath, AUDIO_EXTENSIONS } from './library'
import { readChords, analyzeChords, exportChordsFile, deleteChordsFile, cancelAnalysis, getChordSources } from './chords'
import { getChordifyStatus, openChordifyLogin, openChordifySongPage, logoutChordify, fetchChordifyForSong, importChordifyFile, deleteChordifyDoc } from './chordify'
import { readLyrics, fetchLyricsForSong, importLyricsFile, deleteLyricsFile, exportLyricsFile } from './lyrics'
import { startJob, startLocalJob, cancelJob, searchYouTube } from './pipeline'
import { initUpdater } from './updater'
import { runSmoke } from './smoke'
import { getThumb, clearThumbMemo } from './thumbs'
import { maybePing } from './telemetry'

let mainWindow: BrowserWindow | null = null
let staticServer: Server | null = null

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

function startRendererServer(): Promise<string> {
  const root = normalize(join(__dirname, '../renderer'))
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
        let filePath = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath))
        if (!filePath.startsWith(root)) {
          res.statusCode = 403
          res.end()
          return
        }
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          filePath = join(root, 'index.html')
        }
        res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
        createReadStream(filePath).pipe(res)
      } catch {
        res.statusCode = 404
        res.end()
      }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      staticServer = server
      resolve(`http://localhost:${(server.address() as AddressInfo).port}`)
    })
  })
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim()
  return clean.length > 0 ? clean.slice(0, 120) : 'stems'
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0b10',
    // hiddenInset traffic lights are macOS-only; default frame elsewhere
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const url = await startRendererServer()
    mainWindow.loadURL(url + '/index.html')
  }
}

app.whenReady().then(async () => {
  // self-test mode for the windows-smoke CI job: bootstrap, separate a
  // generated tone through both engines, exercise the GPU plumbing
  // (cuda fail-fast paths + CUDA engine install), exit 0/1 without a window
  if (process.env.STEMKIT_SMOKE === '1') {
    const ok = await runSmoke()
    app.exit(ok ? 0 : 1)
    return
  }

  // existing install (e.g. right after an update): pre-fetch the engine
  // checkpoints the user opted into, in the background, so the first split
  // doesn't stall on a download. Nothing is fetched while both toggles are
  // off (the defaults)
  if (await refreshReady()) {
    const settings = loadSettings()
    if (settings.roformerVocals) void ensureVocalsEngine()
    if (settings.htdemucsFt) void ensureFtWeights()
    if (settings.gpuSplit) void detectGpuVendor().then((vendor) => ensureGpuEngine(undefined, vendor))
    // warm the informational GPU probe so Settings can show it right away
    void hasGpuAcceleration()
  }

  ipcMain.handle('env:status', async () => {
  // restore the AMD ROCm override saved by a previous session's preflight
  // before any python (venv probes, separation runs) can spawn
  applyGpuOverride()
  await detectTools()
    void detectGpuVendor()
    const status = {
      ...getStatus(),
      gpu: gpuAccelerationInfo(),
      gpuVendor: gpuVendorInfo()
    }
    // the probe results land on a later status call; never blocks ready
    if (status.ready) void hasGpuAcceleration()
    return status
  })

  ipcMain.handle('env:bootstrap', async () => {
    const ok = await bootstrap()
    return ok
  })

  ipcMain.handle('env:update-ytdlp', async () => updateYtDlp())

  ipcMain.handle('library:list', () => loadSongs())
  ipcMain.handle('library:delete', (_e, videoId: string) => removeSong(videoId))
  ipcMain.handle('song:buffers', (_e, videoId: string) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    return stemBuffers(videoId, song?.stems)
  })

  ipcMain.handle('jobs:start', async (_e, url: string, model?: string, stems?: string[]) => {
    void startJob(url, model, stems)
    return { started: true }
  })
  ipcMain.handle('jobs:start-local', async (_e, filePath: string, model?: string, stems?: string[]) => {
    void startLocalJob(filePath, model, stems)
    return { started: true }
  })
  ipcMain.handle('files:pick-audio', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose an audio file to split',
      buttonLabel: 'Split',
      properties: ['openFile'],
      filters: [{ name: 'Audio files', extensions: AUDIO_EXTENSIONS }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('jobs:cancel', (_e, videoId?: string) => cancelJob(videoId))

  ipcMain.handle('stem:export', async (_e, videoId: string, stem: string) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    const file = join(stemsDir(videoId), `${stem}.wav`)
    if (!existsSync(file)) throw new Error(`Missing stem ${stem}`)
    const result = await dialog.showSaveDialog({
      title: `Export ${stem}`,
      defaultPath: join(app.getPath('downloads'), `${sanitizeName(song?.title ?? videoId)} - ${stem}.wav`),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    copyFileSync(file, result.filePath)
    return { saved: true, path: result.filePath }
  })

  ipcMain.handle('stems:export-all', async (_e, videoId: string) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    const list = stemsFor(song)
    const dir = stemsDir(videoId)
    for (const name of list) {
      if (!existsSync(join(dir, `${name}.wav`))) throw new Error(`Missing stem ${name}`)
    }
    const result = await dialog.showOpenDialog({
      title: 'Choose export folder',
      buttonLabel: 'Export Here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { saved: false }
    const target = join(result.filePaths[0], sanitizeName(song?.title ?? videoId))
    mkdirSync(target, { recursive: true })
    for (const name of list) {
      copyFileSync(join(dir, `${name}.wav`), join(target, `${name}.wav`))
    }
    let count = list.length
    const mix = mixWavPath(videoId)
    if (existsSync(mix)) {
      copyFileSync(mix, join(target, `${sanitizeName(song?.title ?? 'full track')}.wav`))
      count += 1
    }
    return { saved: true, path: target, count }
  })

  ipcMain.handle('search:youtube', (_e, query: string) => searchYouTube(query))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const next = saveSettings(patch)
    // hideVideo flips the thumbnail source, so cached lookups must retry
    clearThumbMemo()
    return next
  })
  ipcMain.handle('thumb:get', (_e, videoId: string) => getThumb(videoId))
  // the renderer confirms optional-engine downloads explicitly; nothing
  // starts as a side effect of flipping a toggle
  ipcMain.handle('engines:status', () => {
    // warm the cuda probe so gpuReady flips without waiting for a split
    if (getStatus().ready) void hasGpuAcceleration()
    return engineStatus()
  })
  ipcMain.handle('engines:fetch', (_e, which: 'vocals' | 'ft' | 'gpu') => {
    if (which === 'vocals') void ensureVocalsEngine()
    else if (which === 'ft') void ensureFtWeights()
    else void ensureGpuEngine()
  })

  // chords — dual-source: local (offline) + Chordify (subscription, guitar-friendly triads)
  ipcMain.handle('chords:get', (_e, videoId: string) => readChords(videoId))
  ipcMain.handle('chords:sources', (_e, videoId: string) => getChordSources(videoId))
  ipcMain.handle('chords:analyze', (_e, videoId: string) => analyzeChords(videoId))
  ipcMain.handle('chords:delete', (_e, videoId: string) => deleteChordsFile(videoId))
  ipcMain.handle('chords:export', (_e, videoId: string) => exportChordsFile(videoId))
  ipcMain.handle('chords:cancel', (_e, videoId?: string) => cancelAnalysis(videoId))
  // Chordify — requires a paid subscription; authenticates via the app's browser login window
  ipcMain.handle('chordify:status', () => getChordifyStatus())
  ipcMain.handle('chordify:login', () => openChordifyLogin())
  ipcMain.handle('chordify:logout', () => logoutChordify())
  ipcMain.handle('chordify:fetch', async (_e, videoId: string) => {
    try {
      const song = loadSongs().find(s => s.videoId === videoId)
      const dur = song?.duration ?? 0
      if (!dur) throw new Error('Song not found — split it first')
      const doc = await fetchChordifyForSong(videoId, dur)
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chords:done', { videoId })
      return { ok: true, doc }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('chordify:import', async (_e, videoId: string) => {
    try {
      const song = loadSongs().find(s => s.videoId === videoId)
      const dur = song?.duration ?? 0
      if (!dur) throw new Error('Song not found — split it first')
      const doc = await importChordifyFile(videoId, dur)
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chords:done', { videoId })
      return { ok: true, doc }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/cancelled/i.test(msg)) return { ok: false, error: msg }
      return { ok: false, error: msg }
    }
  })
  ipcMain.handle('chordify:delete', (_e, videoId: string) => deleteChordifyDoc(videoId))
  ipcMain.handle('chordify:open', (_e, videoId: string) => openChordifySongPage(videoId))
  // lyrics addon — standalone, never touches chord engine
  ipcMain.handle('lyrics:get', (_e, videoId: string) => readLyrics(videoId))
  ipcMain.handle('lyrics:fetch', async (_e, videoId: string) => {
    try {
      const song = loadSongs().find(s => s.videoId === videoId)
      const dur = song?.duration ?? 0
      if (!dur) throw new Error('Song not found — split it first')
      const doc = await fetchLyricsForSong(videoId, dur)
      return { ok: true, doc }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('lyrics:import', async (_e, videoId: string) => {
    try {
      const song = loadSongs().find(s => s.videoId === videoId)
      const dur = song?.duration ?? 0
      if (!dur) throw new Error('Song not found — split it first')
      const doc = await importLyricsFile(videoId, dur)
      return { ok: true, doc }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/cancelled/i.test(msg)) return { ok: false, error: msg }
      return { ok: false, error: msg }
    }
  })
  ipcMain.handle('lyrics:delete', (_e, videoId: string) => deleteLyricsFile(videoId))
  ipcMain.handle('lyrics:export', (_e, videoId: string) => exportLyricsFile(videoId))
  initUpdater()
  // anonymous usage heartbeat: one POST per install per day
  maybePing()
  ipcMain.handle('open-external', (_e, url: string) => {
    if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) {
      shell.openExternal(url)
    }
  })

  await detectTools()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  cancelJob()
  cancelAnalysis()
  staticServer?.close()
  app.quit()
})
