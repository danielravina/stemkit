// Pure rules for the Export dialog: what starts checked, when export is allowed, and how files are named.
// Title sanitizing for the filesystem happens in the main process; these only build names.

export const MIX_ID = 'mix'

export type ExportMode = 'mixed' | 'separate'

// Mirrors Player's audibility rule so the dialog opens with what the user currently hears.
export function initialSelection(
  stems: string[],
  mutes: Set<string>,
  solos: Set<string>
): Set<string> {
  return new Set(
    stems.filter(
      (id) => id !== MIX_ID && !mutes.has(id) && (solos.size === 0 || solos.has(id))
    )
  )
}

export function canExport(selected: Set<string>, mode: ExportMode): boolean {
  // a mixed file is built from stems only, so the original mix does not count there
  if (mode === 'mixed') return [...selected].some((id) => id !== MIX_ID)
  return selected.size > 0
}

// Deliberately not formatShift: that one uses U+2212 for display, filenames need plain ASCII.
function shiftSuffix(semitones: number): string {
  if (semitones === 0) return ''
  return ` (${semitones > 0 ? '+' : '-'}${Math.abs(semitones)})`
}

// main cuts sanitized names at 120 chars (sanitizeName); the title gives way
// first so the " - drums+bass (+2)" part, which tells two exports apart, survives
const NAME_LIMIT = 120

function withSuffix(title: string, suffix: string): string {
  const room = Math.max(0, NAME_LIMIT - suffix.length)
  const head = title.length > room ? title.slice(0, room).trimEnd() : title
  return `${head}${suffix}`
}

export function mixedBaseName(
  title: string,
  selected: string[],
  allStems: string[],
  semitones: number
): string {
  const chosen = allStems.filter((id) => selected.includes(id))
  const isInstrumental =
    allStems.includes('vocals') &&
    chosen.length === allStems.length - 1 &&
    !chosen.includes('vocals')
  const part = isInstrumental ? 'instrumental' : chosen.join('+')
  return withSuffix(title, ` - ${part}${shiftSuffix(semitones)}`)
}

export function separateFolderName(title: string, semitones: number): string {
  return withSuffix(title, shiftSuffix(semitones))
}
