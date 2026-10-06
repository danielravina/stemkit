// drives the file-dialog filter and the pre-flight extension check for both
// the picker and drag-and-drop; anything here is fair game for ffmpeg to
// decode. Lives in shared/ because the renderer has to reject unsupported
// drops before it starts a job (a failed job keys an empty song id into the
// library list)
export const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'wma',
  'aiff',
  'aif',
  'alac',
  'webm'
]

export function audioExtension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function isAudioPath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(audioExtension(filePath))
}

// local audio files get a synthetic id derived from their absolute path, so
// they flow through the same library/jobs/player plumbing as YouTube songs
// (which key everything off the 11-char video id). Deterministic: re-splitting
// the same path reuses the cached split, and the renderer and main process
// always hash the exact same string that came out of the file dialog
export function localSongId(filePath: string): string {
  // FNV-1a 32-bit
  let hash = 0x811c9dc5
  for (let i = 0; i < filePath.length; i++) {
    hash ^= filePath.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `local-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

// true for synthetic ids minted by localSongId. In-progress jobs only carry
// the id (no Song record yet), so callers that need "is this local?" during
// a split must check this instead of Song.source
export function isLocalId(id: string): boolean {
  return id.startsWith('local-')
}
