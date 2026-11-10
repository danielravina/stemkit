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

// main cuts sanitized names at 120 chars; capping the title first keeps the
// " - drums+bass (+2)" part, which is what tells two exports of a song apart
const TITLE_LIMIT = 80

function shortTitle(title: string): string {
  return title.length > TITLE_LIMIT ? title.slice(0, TITLE_LIMIT).trimEnd() : title
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
  return `${shortTitle(title)} - ${part}${shiftSuffix(semitones)}`
}

export function separateFolderName(title: string, semitones: number): string {
  return `${shortTitle(title)}${shiftSuffix(semitones)}`
}
