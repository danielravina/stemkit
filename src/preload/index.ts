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
  exportStem: (videoId, stem) => ipcRenderer.invoke('stem:export', videoId, stem),
  exportAllStems: (videoId) => ipcRenderer.invoke('stems:export-all', videoId),
  searchYouTube: (query) => ipcRenderer.invoke('search:youtube', query),
  startJob: (url, model, stems) => ipcRenderer.invoke('jobs:start', url, model, stems),
  pickAudioFile: () => ipcRenderer.invoke('files:pick-audio'),
  startLocalJob: (filePath, model, stems) => ipcRenderer.invoke('jobs:start-local', filePath, model, stems),
  cancelJob: (videoId?: string) => ipcRenderer.invoke('jobs:cancel', videoId),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getThumb: (videoId) => ipcRenderer.invoke('thumb:get', videoId),
  onThumbCached: (cb) => subscribe<string>('thumb:cached', cb),
  enginesStatus: () => ipcRenderer.invoke('engines:status'),
  fetchEngine: (which) => ipcRenderer.invoke('engines:fetch', which),
  getChords: (videoId) => ipcRenderer.invoke('chords:get', videoId),
  getChordSources: (videoId) => ipcRenderer.invoke('chords:sources', videoId),
  analyzeChords: (videoId) => ipcRenderer.invoke('chords:analyze', videoId),
  deleteChords: (videoId) => ipcRenderer.invoke('chords:delete', videoId),
  exportChords: (videoId) => ipcRenderer.invoke('chords:export', videoId),
  chordifyStatus: () => ipcRenderer.invoke('chordify:status'),
  chordifyLogin: () => ipcRenderer.invoke('chordify:login'),
  chordifyLogout: () => ipcRenderer.invoke('chordify:logout'),
  chordifyFetch: (videoId) => ipcRenderer.invoke('chordify:fetch', videoId),
  chordifyImport: (videoId) => ipcRenderer.invoke('chordify:import', videoId),
  chordifyDelete: (videoId) => ipcRenderer.invoke('chordify:delete', videoId),
  chordifyOpen: (videoId) => ipcRenderer.invoke('chordify:open', videoId),
  getLyrics: (videoId) => ipcRenderer.invoke('lyrics:get', videoId),
  fetchLyrics: (videoId) => ipcRenderer.invoke('lyrics:fetch', videoId),
  importLyrics: (videoId) => ipcRenderer.invoke('lyrics:import', videoId),
  deleteLyrics: (videoId) => ipcRenderer.invoke('lyrics:delete', videoId),
  exportLyrics: (videoId) => ipcRenderer.invoke('lyrics:export', videoId),
  onUpdateEvent: (cb) => subscribe<UpdateEvent>('update:event', cb),
  onJobEvent: (cb) => subscribe<JobEvent>('job:event', cb),
  onEnvEvent: (cb) => subscribe<EnvEvent>('env:event', cb),
  onSettingsChange: (cb) => subscribe<AppSettings>('settings:changed', cb),
  onChordsDone: (cb) => subscribe<{ videoId: string }>('chords:done', cb),
  onLyricsDone: (cb) => subscribe<{ videoId: string }>('lyrics:done', cb)
}

contextBridge.exposeInMainWorld('stemkit', api)
