// Evaluates the app's own TypeScript rules for test_parity.py.
// stdin: {"root": dir, "calls": [[name, args], ...]}; stdout: [result, ...]
// Numbers JSON can't carry are passed as {"$n": "NaN" | "Infinity" | "-Infinity"}.
import { registerTsHooks } from '../../tests/helpers/ts-resolve.mjs'
import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8'), (_k, v) =>
  v && typeof v === 'object' && '$n' in v ? Number(v.$n) : v)
const src = (f) => new URL(`../../src/${f}`, import.meta.url).href
const hooks = registerTsHooks({ stubEnv: `export const userDataDir = () => ${JSON.stringify(input.root)}` })
const local = await import(src('shared/local.ts'))
const url = await import(src('shared/url.ts'))
const pitch = await import(src('shared/pitch-range.ts'))
const keys = await import(src('shared/keys.ts'))
const rules = await import(src('shared/export-rules.ts'))
const library = await import(src('main/library.ts'))
hooks.deregister()

const fns = {
  localSongId: local.localSongId,
  parseVideoId: url.parseVideoId,
  clampPitch: pitch.clampPitch,
  keyName: keys.keyName,
  KEY_NAMES: () => [...keys.KEY_NAMES],
  AUDIO_EXTENSIONS: () => [...local.AUDIO_EXTENSIONS],
  mixedBaseName: rules.mixedBaseName,
  separateFolderName: rules.separateFolderName,
  originalMixName: rules.originalMixName,
  sanitizeName: library.sanitizeName,
  // normalizePan is private: a fresh save + load runs exactly it
  normalizePan: (song, value) => {
    library.saveSongs([song])
    library.saveStemPan(song.videoId, value)
    return library.loadStemPan(song.videoId)
  }
}
process.stdout.write(JSON.stringify(input.calls.map(([name, args]) => fns[name](...args))))
