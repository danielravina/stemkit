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
