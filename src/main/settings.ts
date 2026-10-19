import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { userDataDir } from './env'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types'

function settingsFile(): string {
  return join(userDataDir(), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const data = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    const settings = { ...DEFAULT_SETTINGS, ...(data && typeof data === 'object' ? data : {}) }
    settings.countInBars = [1, 2, 3, 4].includes(settings.countInBars) ? settings.countInBars : 0
    settings.metronomeEnabled = settings.metronomeEnabled === true
    settings.clickVolume = typeof settings.clickVolume === 'number' && Number.isFinite(settings.clickVolume)
      ? Math.max(0, Math.min(1, settings.clickVolume)) : DEFAULT_SETTINGS.clickVolume
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch }
  const next: AppSettings = {
    countInBars: [1, 2, 3, 4].includes(merged.countInBars) ? merged.countInBars : 0,
    metronomeEnabled: merged.metronomeEnabled === true,
    clickVolume: typeof merged.clickVolume === 'number' && Number.isFinite(merged.clickVolume)
      ? Math.max(0, Math.min(1, merged.clickVolume)) : DEFAULT_SETTINGS.clickVolume,
    shifts: merged.shifts === 2 ? 2 : 1,
    htdemucsFt: !!merged.htdemucsFt,
    roformerVocals: !!merged.roformerVocals,
    gpuSplit: !!merged.gpuSplit,
    hideVideo: !!merged.hideVideo,
    exportFormat: merged.exportFormat === 'aac' ? 'aac' : 'wav'
  }
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings:changed', next)
  }
  return next
}
