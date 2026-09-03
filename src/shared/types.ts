export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | 'piano' | 'guitar'

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
}

export interface EnvStatus {
  python: { found: boolean; path?: string; version?: string }
  ffmpeg: { found: boolean; path?: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
}

export interface EnvEvent {
  message: string
  level: 'info' | 'error' | 'success'
}

export type JobStage = 'metadata' | 'download' | 'convert' | 'separate' | 'finalize'

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

export interface LyricsResult {
  found: boolean
  synced: string | null
  plain: string | null
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
  fetchLyrics(videoId: string, title: string, duration: number): Promise<LyricsResult>
  startJob(url: string, model?: string, stems?: string[]): Promise<{ started: boolean }>
  cancelJob(videoId?: string): Promise<void>
  openExternal(url: string): Promise<void>
  getAppVersion(): Promise<string>
  installUpdate(): void
  onUpdateEvent(cb: (ev: UpdateEvent) => void): () => void
  onJobEvent(cb: (ev: JobEvent) => void): () => void
  onEnvEvent(cb: (ev: EnvEvent) => void): () => void
}
