// Shared so the main process can clamp stored values without importing renderer code
export const PITCH_MIN = -6
export const PITCH_MAX = 6

export function clampPitch(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  // `+ 0` turns -0 (from rounding e.g. -0.4) into 0
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(n))) + 0
}
