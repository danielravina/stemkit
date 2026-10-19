import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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
  getBuffers: (videoId) => ipcRenderer.invoke('song:buffers', videoId),
  getStemPan: (videoId) => ipcRenderer.invoke('song:pan:get', videoId),
  setStemPan: (videoId, pans) => ipcRenderer.invoke('song:pan:set', videoId, pans),
  getTempoSettings: (videoId) => ipcRenderer.invoke('song:tempo:get', videoId),
  setTempoSettings: (videoId, settings) => ipcRenderer.invoke('song:tempo:set', videoId, settings),
  analyzeTempo: (videoId, requestId) => ipcRenderer.invoke('song:tempo:analyze', videoId, requestId),
  cancelTempoAnalysis: (requestId) => ipcRenderer.invoke('song:tempo:cancel', requestId),
  exportStem: (videoId, stem, tempo) => ipcRenderer.invoke('stem:export', videoId, stem, tempo),
  exportAllStems: (videoId, tempo) => ipcRenderer.invoke('stems:export-all', videoId, tempo),
  searchYouTube: (query) => ipcRenderer.invoke('search:youtube', query),
  startJob: (url, model, stems) => ipcRenderer.invoke('jobs:start', url, model, stems),
  pickAudioFile: () => ipcRenderer.invoke('files:pick-audio'),
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
