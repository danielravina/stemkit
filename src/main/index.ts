import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Menu,
  type MenuItemConstructorOptions
} from 'electron'
import { join, normalize, extname } from 'path'
import { existsSync, copyFileSync, mkdirSync, createReadStream, statSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { AppSettings, TempoSettings } from '../shared/types'
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
import {
  loadSongs, removeSong, stemBuffers, stemsDir, stemsFor, mixWavPath,
  AUDIO_EXTENSIONS, loadStemPan, saveStemPan, loadTempoSettings, saveTempoSettings, validateTempo, wavDuration
} from './library'
import { startJob, startLocalJob, cancelJob, searchYouTube } from './pipeline'
import { initUpdater } from './updater'
import { runSmoke } from './smoke'
import { getThumb, clearThumbMemo } from './thumbs'
import { maybePing } from './telemetry'
import { analyzeSongTempo, cancelSongTempo } from './tempo'
import { renderMetronomeWav } from './metronome-wav'
import { manualBeats } from '../shared/metronome'

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

function showAboutWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('app:show-about')
}

function installApplicationMenu(): void {
  const aboutItem: MenuItemConstructorOptions = {
    label: 'About StemKit',
    click: showAboutWindow
  }
  const template: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              aboutItem,
              { type: 'separator' },
              { role: 'services', submenu: [] },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          },
          {
            label: 'Edit',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' }
            ]
          },
          { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
        ]
      : [
          { label: 'File', submenu: [{ role: 'quit' }] },
          { label: 'Help', submenu: [aboutItem] }
        ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function requireExportFfmpeg(): string {
  const ffmpeg = getStatus().ffmpeg.path
  if (!ffmpeg) {
    throw new Error('Something went wrong with the built-in audio tools. Try reinstalling StemKit.')
  }
  return ffmpeg
}

// the bundled ffmpeg is a minimal static build without libmp3lame, so mp3
// isn't an option — aac is a native encoder, no extra library needed
function transcodeToAac(ffmpeg: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-y', '-i', input, '-c:a', 'aac', '-b:a', '256k', output])
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  })
}

async function prepareMetronome(videoId: string, tempo: TempoSettings | undefined, owner: number): Promise<Buffer> {
  if (!/^[\w-]+$/.test(videoId) || !loadSongs().some(song => song.videoId === videoId)) throw new Error('Unknown song')
  const selection = tempo === undefined ? loadTempoSettings(videoId) : validateTempo(tempo)
  const duration = wavDuration(mixWavPath(videoId), false)
  const beats = selection.mode === 'manual'
    ? manualBeats(selection.manualBpm ?? 0, duration)
    : (await analyzeSongTempo(videoId, randomUUID(), owner)).beats
  if (!beats.length) throw new Error('No reliable metronome beats found. Enter BPM manually to export the metronome.')
  return renderMetronomeWav(beats, duration)
}

async function saveMetronome(wav: Buffer, destination: string, format: AppSettings['exportFormat']): Promise<void> {
  if (format === 'wav') { writeFileSync(destination, wav); return }
  const temporary = mkdtempSync(join(tmpdir(), 'stemkit-metronome-'))
  try {
    const source = join(temporary, 'metronome.wav')
    writeFileSync(source, wav)
    await transcodeToAac(requireExportFfmpeg(), source, destination)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
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

  installApplicationMenu()

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
  ipcMain.handle('song:pan:get', (_e, videoId: string) => loadStemPan(videoId))
  ipcMain.handle('song:pan:set', (_e, videoId: string, pans: unknown) => saveStemPan(videoId, pans))
  ipcMain.handle('song:tempo:get', (_e, videoId: string) => loadTempoSettings(videoId))
  ipcMain.handle('song:tempo:set', (_e, videoId: string, settings: unknown) => saveTempoSettings(videoId, settings))
  ipcMain.handle('song:tempo:analyze', async (event, videoId: string, requestId: string) => {
    const owner = event.sender.id
    const cancel = (): void => cancelSongTempo(requestId, owner)
    event.sender.once('destroyed', cancel)
    try { return await analyzeSongTempo(videoId, requestId, owner) }
    finally { event.sender.removeListener('destroyed', cancel) }
  })
  ipcMain.handle('song:tempo:cancel', (event, requestId: string) => cancelSongTempo(requestId, event.sender.id))
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

  ipcMain.handle('stem:export', async (_e, videoId: string, stem: string, tempo?: TempoSettings) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    const file = join(stemsDir(videoId), `${stem}.wav`)
    if (stem !== 'metronome' && !existsSync(file)) throw new Error(`Missing stem ${stem}`)
    const format = loadSettings().exportFormat
    const ext = format === 'aac' ? 'm4a' : 'wav'
    const result = await dialog.showSaveDialog({
      title: `Export ${stem}`,
      defaultPath: join(
        app.getPath('downloads'),
        `${sanitizeName(song?.title ?? videoId)} - ${stem}.${ext}`
      ),
      filters: [{ name: format === 'aac' ? 'AAC audio' : 'WAV audio', extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    if (stem === 'metronome') {
      await saveMetronome(await prepareMetronome(videoId, tempo, _e.sender.id), result.filePath, format)
    } else if (format === 'aac') {
      await transcodeToAac(requireExportFfmpeg(), file, result.filePath)
    } else {
      copyFileSync(file, result.filePath)
    }
    return { saved: true, path: result.filePath }
  })

  ipcMain.handle('stems:export-all', async (_e, videoId: string, tempo?: TempoSettings) => {
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
    const format = loadSettings().exportFormat
    const ext = format === 'aac' ? 'm4a' : 'wav'
    const ffmpeg = format === 'aac' ? requireExportFfmpeg() : null
    for (const name of list) {
      const src = join(dir, `${name}.wav`)
      const dest = join(target, `${name}.${ext}`)
      if (ffmpeg) await transcodeToAac(ffmpeg, src, dest)
      else copyFileSync(src, dest)
    }
    let count = list.length
    const mix = mixWavPath(videoId)
    if (existsSync(mix)) {
      const mixName = sanitizeName(song?.title ?? 'full track')
      const mixDest = join(target, `${mixName.toLowerCase() === 'metronome' ? `${mixName} - full track` : mixName}.${ext}`)
      if (ffmpeg) await transcodeToAac(ffmpeg, mix, mixDest)
      else copyFileSync(mix, mixDest)
      count += 1
    }
    let metronome: Buffer | null = null
    let warning: string | undefined
    try { metronome = await prepareMetronome(videoId, tempo, _e.sender.id) }
    catch (error) { warning = `Stems exported, but the metronome was skipped: ${error instanceof Error ? error.message : String(error)}` }
    if (metronome) {
      await saveMetronome(metronome, join(target, `metronome.${ext}`), format)
      count += 1
    }
    return { saved: true, path: target, count, warning }
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
  initUpdater()
  // anonymous usage heartbeat: one POST per install per day
  maybePing()
  ipcMain.handle('open-external', (_e, value: string) => {
    try {
      const url = new URL(value)
      const youtube = ['youtube.com', 'www.youtube.com', 'youtu.be'].includes(url.hostname)
      const website = url.hostname === 'stemkit.pages.dev'
      const projectGithub =
        url.hostname === 'github.com' && /^\/danielravina\/stemkit(?:\/|$)/.test(url.pathname)
      if (url.protocol === 'https:' && (youtube || website || projectGithub)) {
        shell.openExternal(url.toString())
      }
    } catch {
      // Ignore malformed or unsupported external URLs.
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
  staticServer?.close()
  app.quit()
})
