export type KeyMode = 'major' | 'minor'

// Index = pitch class (C = 0). One fixed spelling per pitch class, the most common one for each key.
const MAJOR = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const MINOR = ['Cm', 'C♯m', 'Dm', 'E♭m', 'Em', 'Fm', 'F♯m', 'Gm', 'G♯m', 'Am', 'B♭m', 'Bm']

export const KEY_NAMES: readonly string[] = [...MAJOR, ...MINOR]

const mod12 = (n: number): number => ((n % 12) + 12) % 12

export function keyName(tonic: number, mode: KeyMode): string {
  return (mode === 'major' ? MAJOR : MINOR)[mod12(tonic)]
}

export function parseKey(name: string): { tonic: number; mode: KeyMode } | null {
  const i = KEY_NAMES.indexOf(name)
  if (i < 0) return null
  return i < 12 ? { tonic: i, mode: 'major' } : { tonic: i - 12, mode: 'minor' }
}
