import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { JobEvent, EnvEvent, UpdateEvent, StemKitApi } from '../shared/types'

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
  exportStem: (videoId, stem) => ipcRenderer.invoke('stem:export', videoId, stem),
  exportAllStems: (videoId) => ipcRenderer.invoke('stems:export-all', videoId),
  searchYouTube: (query) => ipcRenderer.invoke('search:youtube', query),
  fetchLyrics: (videoId, title, duration) =>
    ipcRenderer.invoke('lyrics:fetch', videoId, title, duration),
  startJob: (url, model, stems) => ipcRenderer.invoke('jobs:start', url, model, stems),
  cancelJob: (videoId?: string) => ipcRenderer.invoke('jobs:cancel', videoId),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (cb) => subscribe<UpdateEvent>('update:event', cb),
  onJobEvent: (cb) => subscribe<JobEvent>('job:event', cb),
  onEnvEvent: (cb) => subscribe<EnvEvent>('env:event', cb)
}

contextBridge.exposeInMainWorld('stemkit', api)
