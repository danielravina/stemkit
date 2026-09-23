import type { ChordSegment, ChordsDoc } from '../../../shared/types'

export const NOTES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const
const SHARP_TO_FLAT: Record<string,string> = { "C#":"Db","D#":"Eb","F#":"Gb","G#":"Ab","A#":"Bb" }

export function toFlat(name: string): string {
  // name like "C#m7" -> "Dbm7", handle root only
  for (const sharp of Object.keys(SHARP_TO_FLAT)) {
    if (name.startsWith(sharp)) return SHARP_TO_FLAT[sharp] + name.slice(sharp.length)
  }
  return name
}
export function displayLabel(label: string, useFlats: boolean): string {
  if (!useFlats || label==="N") return label
  return toFlat(label)
}

// ── transpose ──────────────────────────────────────────────────────────

export function transposeDoc(doc: ChordsDoc, semitones: number): ChordsDoc {
  if (semitones === 0) return doc
  const n = ((semitones % 12) + 12) % 12
  if (n === 0) return doc
  return {
    ...doc,
    chords: doc.chords.map(s => {
      if (s.chord === "N" || s.root < 0) return s
      const nr = (s.root + n) % 12
      const suf = suffixOf(s.chord, s.root)
      return { ...s, root: nr, chord: NOTES[nr] + suf }
    })
  }
}

function suffixOf(label: string, root: number): string {
  if (label === "N") return ""
  const rname = NOTES[root]
  return label.startsWith(rname) ? label.slice(rname.length) : ""
}

export function transposeChord(label: string, semitones: number): string {
  if (label === "N") return "N"
  let root = -1
  let suf = ""
  for (let i = 11; i >= 0; i--) {
    if (label.startsWith(NOTES[i])) { root = i; suf = label.slice(NOTES[i].length); break }
  }
  if (root < 0) return label
  const nr = (((root + semitones) % 12) + 12) % 12
  return NOTES[nr] + suf
}

// For capo: shape = sounding - capo
// sounding = original + transpose
// shape = original + transpose - capo
export function getDisplayDoc(doc: ChordsDoc, transpose: number, capo: number): ChordsDoc {
  const n = transpose - capo
  return transposeDoc(doc, n)
}
export function getSoundingDoc(doc: ChordsDoc, transpose: number): ChordsDoc {
  return transposeDoc(doc, transpose)
}

// ── time → active segment ────────────────────────────────────────────

export function activeChord(doc: ChordsDoc | null, t: number): ChordSegment | null {
  if (!doc || doc.chords.length === 0) return null
  for (const c of doc.chords) {
    if (t >= c.time && t < c.time + c.duration) return c
  }
  const last = doc.chords[doc.chords.length -1]
  if (t >= last.time && t <= last.time + last.duration + 0.15) return last
  return null
}

export function nextChords(doc: ChordsDoc | null, t: number, n = 5): ChordSegment[] {
  if (!doc) return []
  const idx = doc.chords.findIndex(c => t < c.time + c.duration)
  if (idx < 0) return []
  return doc.chords.slice(idx, idx + n)
}

// ── key detection ──────────────────────────────────────────────────────

export function detectKey(doc: ChordsDoc | null): { root: number; nameSharp: string } | null {
  if (!doc || doc.chords.length===0) return null
  const freq = new Map<number, number>()
  for (const c of doc.chords) if (c.root >= 0) freq.set(c.root, (freq.get(c.root) || 0) + c.duration)
  let best: [number, number] = [0, 0]
  for (const [r,d] of freq) if (d > best[1]) best=[r,d]
  if (best[1]===0) return null
  return { root: best[0], nameSharp: NOTES[best[0]] }
}

// ── guitar diagrams ──────────────────────────────────────────────────

type Fret = number // -1 = mute x, 0 = open

export interface ChordVoicing {
  name: string // canonical chord label (display, sharp)
  frets: [Fret,Fret,Fret,Fret,Fret,Fret] // low E .. high e
  fingers?: (number|null)[] // 1-4 or null for open/mute
  bar?: { fret: number; from: number; to: number } // barre
}

// Curated open-position dictionary — low, playable shapes where they exist.
// For missing roots we generate barre shapes below, but these open shapes are preferred when available.
const SHAPES: Record<string, ChordVoicing> = {
  // majors — open CAGED
  "C":   { name:"C",  frets: [-1,3,2,0,1,0], fingers:[null,3,2,null,1,null] },
  "G":   { name:"G",  frets: [3,2,0,0,0,3],  fingers:[2,1,null,null,null,3] },
  "D":   { name:"D",  frets: [-1,-1,0,2,3,2],fingers:[null,null,null,1,3,2] },
  "A":   { name:"A",  frets: [-1,0,2,2,2,0], fingers:[null,null,1,2,3,null] },
  "E":   { name:"E",  frets: [0,2,2,1,0,0], fingers:[null,2,3,1,null,null] },
  "F":   { name:"F",  frets: [1,3,3,2,1,1], fingers:[1,3,4,2,1,1], bar:{fret:1,from:0,to:5} },
  // sharps/flats barre majors (E-shape barre is the generic; these explicit low barre positions match theory)
  "C#":  { name:"C#", frets: [-1,4,6,6,6,4], fingers:[null,1,3,3,3,1], bar:{fret:4,from:1,to:5} },
  "D#":  { name:"D#", frets: [-1,6,8,8,8,6], fingers:[null,1,3,3,3,1], bar:{fret:6,from:1,to:5} },
  "F#":  { name:"F#", frets: [2,4,4,3,2,2], fingers:[1,3,4,2,1,1], bar:{fret:2,from:0,to:5} },
  "G#":  { name:"G#", frets: [4,6,6,5,4,4], fingers:[1,3,4,2,1,1], bar:{fret:4,from:0,to:5} },
  "A#":  { name:"A#", frets: [-1,1,3,3,3,1], fingers:[null,1,3,3,3,1], bar:{fret:1,from:1,to:5} },
  // minors
  "Am":  { name:"Am", frets: [-1,0,2,2,1,0], fingers:[null,null,2,3,1,null] },
  "Em":  { name:"Em", frets: [0,2,2,0,0,0], fingers:[null,2,3,null,null,null] },
  "Dm":  { name:"Dm", frets: [-1,-1,0,2,3,1],fingers:[null,null,null,1,3,2] },
  "Cm":  { name:"Cm", frets: [-1,3,5,5,4,3], fingers:[null,1,3,4,2,1], bar:{fret:3,from:1,to:5} },
  "Bm":  { name:"Bm", frets: [-1,2,4,4,3,2], fingers:[null,1,3,4,2,1], bar:{fret:2,from:1,to:5} },
  "F#m": { name:"F#m", frets: [2,4,4,2,2,2], fingers:[1,3,4,1,1,1], bar:{fret:2,from:0,to:5} },
  "G#m": { name:"G#m", frets: [4,6,6,4,4,4], fingers:[1,3,4,1,1,1], bar:{fret:4,from:0,to:5} },
  "C#m": { name:"C#m", frets: [-1,4,6,6,5,4], fingers:[null,1,3,4,2,1], bar:{fret:4,from:1,to:5} },
  "D#m": { name:"D#m", frets: [-1,6,8,8,7,6], fingers:[null,1,3,4,2,1], bar:{fret:6,from:1,to:5} },
  "A#m": { name:"A#m", frets: [-1,1,3,3,2,1], fingers:[null,1,3,3,2,1], bar:{fret:1,from:1,to:5} },
  "Fm":  { name:"Fm", frets: [1,3,3,1,1,1], fingers:[1,3,4,1,1,1], bar:{fret:1,from:0,to:5} },
  "Gm":  { name:"Gm", frets: [3,5,5,3,3,3], fingers:[1,3,4,1,1,1], bar:{fret:3,from:0,to:5} },
  // 7ths
  "C7":  { name:"C7", frets: [-1,3,2,3,1,0], fingers:[null,3,2,4,1,null] },
  "G7":  { name:"G7", frets: [3,2,0,0,0,1], fingers:[3,2,null,null,null,1] },
  "A7":  { name:"A7", frets: [-1,0,2,0,2,0], fingers:[null,null,1,null,2,null] },
  "E7":  { name:"E7", frets: [0,2,0,1,0,0], fingers:[null,2,null,1,null,null] },
  "D7":  { name:"D7", frets: [-1,-1,0,2,1,2],fingers:[null,null,null,2,1,3] },
  "B7":  { name:"B7", frets: [-1,2,1,2,0,2], fingers:[null,2,1,3,null,4] },
  // maj7
  "Cmaj7": { name:"Cmaj7", frets: [-1,3,2,0,0,0], fingers:[null,3,2,null,null,null] },
  "Gmaj7": { name:"Gmaj7", frets: [3,2,0,0,0,2], fingers:[3,2,null,null,null,1] },
  "Fmaj7": { name:"Fmaj7", frets: [1,3,2,2,1,0], fingers:[1,3,2,2,1,null], bar:{fret:1,from:0,to:3} },
  "Amaj7": { name:"Amaj7", frets: [-1,0,2,1,2,0], fingers:[null,null,2,1,3,null] },
  "Dmaj7": { name:"Dmaj7", frets: [-1,-1,0,2,2,2], fingers:[null,null,null,1,2,3] },
  "Emaj7": { name:"Emaj7", frets: [0,2,1,1,0,0], fingers:[null,2,1,1,null,null] },
  // m7
  "Am7": { name:"Am7", frets: [-1,0,2,0,1,0], fingers:[null,null,2,null,1,null] },
  "Em7": { name:"Em7", frets: [0,2,2,0,3,0], fingers:[null,1,2,null,3,null] },
  "Dm7": { name:"Dm7", frets: [-1,-1,0,2,1,1],fingers:[null,null,null,2,1,1] },
  "Cm7": { name:"Cm7", frets: [-1,3,5,3,4,3], fingers:[null,1,3,1,2,1], bar:{fret:3,from:1,to:5} },
  "Bm7": { name:"Bm7", frets: [-1,2,4,2,3,2], fingers:[null,1,3,1,2,1], bar:{fret:2,from:1,to:5} },
  "Gm7": { name:"Gm7", frets: [3,5,3,3,3,3], fingers:[1,3,1,1,1,1], bar:{fret:3,from:0,to:5} },
  "Fm7": { name:"Fm7", frets: [1,3,1,1,1,1], fingers:[1,3,1,1,1,1], bar:{fret:1,from:0,to:5} },
  // dim
  "Cdim": { name:"Cdim", frets: [-1,3,4,3,4,3], fingers:[null,1,3,2,4,1], bar:{fret:3,from:1,to:5} },
  "Ddim": { name:"Ddim", frets: [-1,-1,0,1,0,1], fingers:[null,null,null,1,null,2] },
  "Edim": { name:"Edim", frets: [0,1,2,0,2,0], fingers:[null,1,2,null,3,null] },
  "Gdim": { name:"Gdim", frets: [3,4,5,3,5,3], fingers:[1,2,4,1,4,1], bar:{fret:3,from:0,to:5} },
  // sus2 / sus4
  "Csus2": { name:"Csus2", frets: [-1,3,0,0,1,3], fingers:[null,2,null,null,1,3] },
  "Dsus2": { name:"Dsus2", frets: [-1,-1,0,2,3,0], fingers:[null,null,null,1,2,null] },
  "Esus2": { name:"Esus2", frets: [0,2,4,4,0,0], fingers:[null,1,3,4,null,null] },
  "Gsus2": { name:"Gsus2", frets: [3,0,0,2,3,3], fingers:[3,null,null,1,2,3] },
  "Asus2": { name:"Asus2", frets: [-1,0,2,2,0,0], fingers:[null,null,1,2,null,null] },
  "Csus4": { name:"Csus4", frets: [-1,3,3,0,1,1], fingers:[null,2,3,null,1,1], bar:{fret:3,from:1,to:2} },
  "Dsus4": { name:"Dsus4", frets: [-1,-1,0,2,3,3], fingers:[null,null,null,1,2,3] },
  "Esus4": { name:"Esus4", frets: [0,2,2,2,0,0], fingers:[null,1,2,3,null,null] },
  "Gsus4": { name:"Gsus4", frets: [3,3,0,0,1,3], fingers:[2,3,null,null,1,4] },
  "Asus4": { name:"Asus4", frets: [-1,0,2,2,3,0], fingers:[null,null,1,2,3,null] },
}

// ── barre generators for missing combos ─────────────────────────────────

// E-shape templates (root on 6th string, open E = 4)
const TPL_E_MAJOR: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,2,1,0,0]
const TPL_E_MINOR: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,2,0,0,0]
const TPL_E_7: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,0,1,0,0]
const TPL_E_M7: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,0,0,0,0] // 022030 is also common; this keeps 5th open for cleaner barre
const TPL_E_MAJ7: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,1,1,0,0]
const TPL_E_DIM: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,1,2,0,2,0]
const TPL_E_SUS2: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,4,4,0,0]
const TPL_E_SUS4: [Fret,Fret,Fret,Fret,Fret,Fret] = [0,2,2,2,0,0]

// A-shape templates (root on 5th string, open A = 9)
const TPL_A_MAJOR: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,2,2,0]
const TPL_A_MINOR: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,2,1,0]
const TPL_A_7: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,0,2,0]
const TPL_A_M7: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,0,1,0]
const TPL_A_MAJ7: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,1,2,0]
const TPL_A_DIM: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,1,2,1,2]
const TPL_A_SUS2: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,2,0,0]
const TPL_A_SUS4: [Fret,Fret,Fret,Fret,Fret,Fret] = [-1,0,2,2,3,0]

function tplForQuality(q: string): { e: typeof TPL_E_MAJOR; a: typeof TPL_A_MAJOR } {
  switch(q){
    case "": return { e: TPL_E_MAJOR, a: TPL_A_MAJOR }
    case "m": return { e: TPL_E_MINOR, a: TPL_A_MINOR }
    case "7": return { e: TPL_E_7, a: TPL_A_7 }
    case "m7": return { e: TPL_E_M7, a: TPL_A_M7 }
    case "maj7": return { e: TPL_E_MAJ7, a: TPL_A_MAJ7 }
    case "dim": return { e: TPL_E_DIM, a: TPL_A_DIM }
    case "sus2": return { e: TPL_E_SUS2, a: TPL_A_SUS2 }
    case "sus4": return { e: TPL_E_SUS4, a: TPL_A_SUS4 }
    default: return { e: TPL_E_MAJOR, a: TPL_A_MAJOR }
  }
}

function shiftTpl(tpl: readonly Fret[], fret: number): [Fret,Fret,Fret,Fret,Fret,Fret] {
  return tpl.map(v => v<0 ? -1 : v + fret) as [Fret,Fret,Fret,Fret,Fret,Fret]
}

function maxFret(frets: readonly Fret[]): number {
  let m = 0
  for (const f of frets) if (f>m) m=f
  return m
}

function makeBarre(root: number, quality: string): ChordVoicing | null {
  const name = NOTES[root] + quality
  const { e: te, a: ta } = tplForQuality(quality)
  const fE = (root - 4 + 12) % 12 // E=4
  const fA = (root - 9 + 12) % 12 // A=9
  const candE = shiftTpl(te, fE)
  const candA = shiftTpl(ta, fA)
  // Prefer lower max fret; if tie prefer A shape for 5th-string roots (common), E for 6th
  const mE = maxFret(candE)
  const mA = maxFret(candA)
  // If both >12, prefer lower still (wraps octave). Cap frets >12 by subtracting 12? Not needed.
  // Choose lower max; if equal, prefer shape with barre not too high and open strings where possible
  let frets: [Fret,Fret,Fret,Fret,Fret,Fret]
  let fret: number
  let type: 'E' | 'A'
  if (mA < mE || (mA===mE && fA <= 4 && fE > fA)) { frets = candA; fret = fA; type='A' }
  else { frets = candE; fret = fE; type='E' }

  // Build barre info: if fret>0, barre across relevant strings
  let bar: { fret:number; from:number; to:number } | undefined
  if (fret>0) {
    if (type==='E') bar = { fret, from:0, to:5 }
    else bar = { fret, from:1, to:5 } // A-shape barre from A string
  }
  // Fingers: not critical, leave simple
  return { name, frets, bar }
}

export function lookupVoicing(chord: string): ChordVoicing | null {
  if (chord === "N") return null
  if (SHAPES[chord]) return SHAPES[chord]
  // Parse root + quality
  let root = -1
  let qual = ""
  for (let i=11;i>=0;i--) if (chord.startsWith(NOTES[i])) { root=i; qual=chord.slice(NOTES[i].length); break }
  if (root<0) return null
  // Normalize quality to our 8
  // Handle edge: "m" vs "maj7" etc already in SHAPES exact check, so here generate accurately
  const allowed = new Set(["","m","7","m7","maj7","dim","sus2","sus4"])
  let q = qual
  if (!allowed.has(q)) {
    // Map common variants: "min" -> "m" handled upstream, but keep fallback
    if (q==="min") q="m"
    else if (q==="min7"||q==="m7b5") q="m7"
    else q="" // fallback to major
  }
  const gen = makeBarre(root, q)
  if (gen) return { ...gen, name: chord } // keep requested label (sharp) as name
  // final fallback: major barre
  const fb = makeBarre(root, "")
  if (fb) return { ...fb, name: chord }
  return null
}

// transpose diagram by semitones via barre shift (for non-capo transpose)
export function transposeVoicing(v: ChordVoicing, semitones: number): ChordVoicing {
  const n = ((semitones%12)+12)%12
  if (n===0) return v
  const frets = v.frets.map(f=> f<0 ? -1 : f+n) as ChordVoicing["frets"]
  let bar: ChordVoicing["bar"] = undefined
  if (v.bar) bar = { fret: v.bar.fret + n, from: v.bar.from, to: v.bar.to }
  return { ...v, frets, bar, name: transposeChord(v.name, semitones) }
}

export function chordColor(chord: string): string {
  if (chord === "N") return "rgba(255,255,255,0.12)"
  let root=-1
  for (let i=11;i>=0;i--) if (chord.startsWith(NOTES[i])) { root=i; break }
  if (root<0) return "#A78BFA"
  const hues = [0, 20, 40, 90, 120, 180, 210, 270, 300, 330, 15, 200]
  const hue = hues[root % hues.length]
  return `hsl(${hue} 70% 62%)`
}

export function fmtChordTime(s: number): string {
  const m = Math.floor(s/60); const sec = Math.floor(s%60)
  return `${m}:${String(sec).padStart(2,"0")}`
}
