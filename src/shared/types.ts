export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | 'piano' | 'guitar'

// which GPU vendor GPU acceleration targets: NVIDIA via CUDA torch (windows
// + linux), AMD via ROCm torch (linux only)
export type GpuVendor = 'nvidia' | 'amd'

export const DEFAULT_STEMS: string[] = ['vocals', 'drums', 'bass', 'other']

// roformer_hybrid = mel-band roformer vocals + htdemucs drums/bass/other
export const MODEL_DEFAULT = 'roformer_hybrid'
export const MODEL_EXTENDED = 'htdemucs_6s'

export interface Song {
  videoId: string
  title: string
  duration: number
  addedAt: number
  model?: string
  stems?: string[]
  took?: number
  // local audio files carry their own mix; absent means a YouTube source
  source?: 'local'
}

export interface AppSettings {
  shifts: 1 | 2
  htdemucsFt: boolean
  roformerVocals: boolean
  // windows/linux: separate on the GPU instead of the CPU. The toggle is only
  // rendered when an NVIDIA GPU (cuda torch) or an AMD GPU on linux (rocm
  // torch) is detected; enabling it downloads the ~2.5GB GPU build of torch
  // on first use
  gpuSplit: boolean
  // hide the YouTube video while playing: stems are always played locally,
  // this stops streaming the video and falls back to cached thumbnails
  hideVideo: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  shifts: 1,
  htdemucsFt: false,
  roformerVocals: false,
  gpuSplit: false,
  hideVideo: false
}

export interface EngineStatus {
  vocalsDownloading: boolean
  vocalsReady: boolean
  ftDownloading: boolean
  ftVerified: boolean
  // gpu torch engine (windows/linux; cuda for nvidia, rocm for amd on linux)
  gpuDownloading: boolean
  gpuReady: boolean
}

export interface EnvStatus {
  python: { found: boolean; path?: string; version?: string }
  ffmpeg: { found: boolean; path?: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
  gpu?: boolean
  // windows/linux only: which GPU vendor was detected (gates the GPU toggle
  // in Settings; amd is only detected on linux)
  gpuVendor?: GpuVendor
}

export interface EnvEvent {
  message: string
  level: 'info' | 'error' | 'success'
}

export type JobStage = 'metadata' | 'download' | 'convert' | 'separate' | 'chords' | 'lyrics' | 'finalize'

export interface LyricLine {
  time: number
  duration: number
  text: string
}
export interface LyricsDoc {
  version: 1
  duration: number
  source: 'youtube' | 'imported' | 'manual'
  language?: string
  lines: LyricLine[]
  generatedAt: number
}

export interface ChordSegment {
  time: number
  duration: number
  chord: string
  root: number
  quality: string
  score: number
}

export interface ChordsDoc {
  version: 1
  duration: number
  hop: number
  win: number
  generatedAt: number
  chords: ChordSegment[]
  source?: 'local' | 'chordify'
  chordifyMeta?: { bpm: number; barLength: number }
}

export interface ChordifyStatus {
  connected: boolean
  cookieCount: number
}

export interface ChordSources {
  local: ChordsDoc | null
  chordify: ChordsDoc | null
  active: 'local' | 'chordify' | null
}

export interface JobProgress {
  videoId: string
  title?: string
  stage: JobStage
  pct: number
  message?: string
  model?: string
}

export interface JobDone {
  videoId: string
  song: Song
}

export interface JobFailed {
  videoId: string
  message: string
}

export type JobEvent =
  | { kind: 'progress'; data: JobProgress }
  | { kind: 'done'; data: JobDone }
  | { kind: 'failed'; data: JobFailed }

export interface SearchResult {
  videoId: string
  title: string
  channel?: string
  duration?: number
}

export interface UpdateEvent {
  status: 'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error'
  version?: string
  pct?: number
}

export interface StemKitApi {
  envStatus(): Promise<EnvStatus>
  envBootstrap(): Promise<boolean>
  envUpdateYtDlp(): Promise<boolean>
  listSongs(): Promise<Song[]>
  deleteSong(videoId: string): Promise<void>
  getBuffers(videoId: string): Promise<Record<string, Uint8Array>>
  exportStem(videoId: string, stem: string): Promise<{ saved: boolean; path?: string }>
  exportAllStems(videoId: string): Promise<{ saved: boolean; path?: string; count?: number }>
  searchYouTube(query: string): Promise<SearchResult[]>
  startJob(url: string, model?: string, stems?: string[]): Promise<{ started: boolean }>
  pickAudioFile(): Promise<string | null>
  startLocalJob(filePath: string, model?: string, stems?: string[]): Promise<{ started: boolean }>
  cancelJob(videoId?: string): Promise<void>
  openExternal(url: string): Promise<void>
  getAppVersion(): Promise<string>
  installUpdate(): void
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getThumb(videoId: string): Promise<string | null>
  onThumbCached(cb: (videoId: string) => void): () => void
  enginesStatus(): Promise<EngineStatus>
  fetchEngine(which: 'vocals' | 'ft' | 'gpu'): Promise<void>
  getChords(videoId: string): Promise<ChordsDoc | null>
  analyzeChords(videoId: string): Promise<{ started: boolean; error?: string }>
  deleteChords(videoId: string): Promise<void>
  exportChords(videoId: string): Promise<{ saved: boolean; path?: string }>
  getChordSources(videoId: string): Promise<ChordSources>
  // Chordify — requires a paid Chordify subscription logged in via the app
  chordifyStatus(): Promise<ChordifyStatus>
  chordifyLogin(): Promise<{ success: boolean; error?: string }>
  chordifyLogout(): Promise<void>
  chordifyFetch(videoId: string): Promise<{ ok: boolean; error?: string; doc?: ChordsDoc }>
  chordifyImport(videoId: string): Promise<{ ok: boolean; error?: string; doc?: ChordsDoc }>
  chordifyDelete(videoId: string): Promise<void>
  chordifyOpen(videoId: string): Promise<void>
  // Lyrics addon — YouTube auto-captions + file import (LRC/SRT/VTT)
  getLyrics(videoId: string): Promise<LyricsDoc | null>
  fetchLyrics(videoId: string): Promise<{ ok: boolean; error?: string; doc?: LyricsDoc }>
  importLyrics(videoId: string): Promise<{ ok: boolean; error?: string; doc?: LyricsDoc }>
  deleteLyrics(videoId: string): Promise<void>
  exportLyrics(videoId: string): Promise<{ saved: boolean; path?: string }>
  onUpdateEvent(cb: (ev: UpdateEvent) => void): () => void
  onJobEvent(cb: (ev: JobEvent) => void): () => void
  onEnvEvent(cb: (ev: EnvEvent) => void): () => void
  onSettingsChange(cb: (settings: AppSettings) => void): () => void
  onChordsDone(cb: (ev: { videoId: string }) => void): () => void
  onLyricsDone(cb: (ev: { videoId: string }) => void): () => void
}
