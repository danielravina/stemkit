import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { JobEvent, EnvEvent, UpdateEvent, AppSettings, StemKitApi } from '../shared/types'

function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, data: T): void => cb(data)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: StemKitApi = {
  envStatus: () => ipcRenderer.invoke('env:status'),
  envBootstrap: () => ipcRenderer.invoke('env:bootstrap'),
  envUpdateYtDlp: () => ipcRenderer.invoke('env:update-ytdlp'),
  listSongs: () => ipcRenderer.invoke('library:list'),
  deleteSong: (videoId) => ipcRenderer.invoke('library:delete', videoId),
  clearLibrary: () => ipcRenderer.invoke('library:clear'),
  getBuffers: (videoId) => ipcRenderer.invoke('song:buffers', videoId),
  getStemPan: (videoId) => ipcRenderer.invoke('song:pan:get', videoId),
  detectKey: (videoId, force) => ipcRenderer.invoke('song:key:detect', videoId, force === true),
  setKeyOverride: (videoId, override) => ipcRenderer.invoke('song:key:set', videoId, override),
  setStemPan: (videoId, pans) => ipcRenderer.invoke('song:pan:set', videoId, pans),
  getPitch: (videoId) => ipcRenderer.invoke('song:pitch:get', videoId),
  setPitch: (videoId, semitones) => ipcRenderer.invoke('song:pitch:set', videoId, semitones),
  exportStem: (videoId, stem) => ipcRenderer.invoke('stem:export', videoId, stem),
  exportBegin: (kind, name) => ipcRenderer.invoke('export:begin', kind, name),
  exportWrite: (token, fileName, wav) => ipcRenderer.invoke('export:write', token, fileName, wav),
  exportEnd: (token) => ipcRenderer.invoke('export:end', token),
  exportReveal: (path) => ipcRenderer.invoke('export:reveal', path),
  getMix: (videoId) => ipcRenderer.invoke('song:mix', videoId),
  searchYouTube: (query) => ipcRenderer.invoke('search:youtube', query),
  startJob: (url, model, stems) => ipcRenderer.invoke('jobs:start', url, model, stems),
  pickAudioFile: () => ipcRenderer.invoke('files:pick-audio'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  // Electron 32 dropped the File.path augmentation, so a dropped file's path
  // on disk has to be resolved here — it is the only place with node access
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startLocalJob: (filePath, model, stems) => ipcRenderer.invoke('jobs:start-local', filePath, model, stems),
  cancelJob: (videoId?: string) => ipcRenderer.invoke('jobs:cancel', videoId),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getThumb: (videoId) => ipcRenderer.invoke('thumb:get', videoId),
  onThumbCached: (cb) => subscribe<string>('thumb:cached', cb),
  enginesStatus: () => ipcRenderer.invoke('engines:status'),
  fetchEngine: (which) => ipcRenderer.invoke('engines:fetch', which),
  onUpdateEvent: (cb) => subscribe<UpdateEvent>('update:event', cb),
  onShowAbout: (cb) => subscribe<void>('app:show-about', cb),
  onJobEvent: (cb) => subscribe<JobEvent>('job:event', cb),
  onEnvEvent: (cb) => subscribe<EnvEvent>('env:event', cb),
  onSettingsChange: (cb) => subscribe<AppSettings>('settings:changed', cb)
}

contextBridge.exposeInMainWorld('stemkit', api)
