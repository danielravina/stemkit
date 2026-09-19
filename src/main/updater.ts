import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

function send(status: string, payload?: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:event', { status, ...payload })
  }
}

export function initUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // pins every client to the GitHub release marked "Latest" (electron-updater
  // resolves that via the GitHub API when allowPrerelease is false). The
  // default — true for beta-suffixed app versions — walks the releases feed
  // for the newest beta tag instead, which once served an untested
  // pre-release to everyone. Test builds stay drafts (invisible here) and
  // testers install them manually
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => send('checking'))
  autoUpdater.on('update-available', (info) => {
    send('available', { version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => send('none', { version: info.version }))
  autoUpdater.on('download-progress', (p) => send('progress', { pct: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    send('downloaded', { version: info.version })
  })
  autoUpdater.on('error', () => send('error'))

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })
  ipcMain.handle('update:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // electron-updater only supports AppImage on linux — deb installs update
  // by re-downloading, so no automatic checks there (the handlers above
  // stay registered and simply report no update)
  if (process.platform === 'linux' && !process.env.APPIMAGE) return

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 5000)
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 6 * 60 * 60 * 1000)
}
