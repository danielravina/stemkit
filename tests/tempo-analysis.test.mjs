import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-analysis-'))
after(() => rmSync(root, { recursive: true, force: true }))
const script = join(root, 'analyze.cjs')
writeFileSync(script, `for (const name of ['OPENBLAS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS']) { if (process.env[name] !== '1') throw new Error('Tempo worker must bound math threads: ' + name) }; const fs = require('node:fs'); const data = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); setTimeout(() => console.log(JSON.stringify(data.result || data)), data.delay || 0)`)
const moduleUrl = new URL('../src/main/tempo.ts', import.meta.url).href
const libraryUrl = new URL('../src/main/library.ts', import.meta.url).href
const envUrl = `data:text/javascript,${encodeURIComponent(`export const userDataDir = () => ${JSON.stringify(root)}; export const venvPython = () => ${JSON.stringify(process.execPath)}; export const tempoScript = () => ${JSON.stringify(script)}; export const ensureTempoDeps = async () => { await globalThis.tempoDepsGate };` )}`
const hooks = registerHooks({ resolve(specifier, context, next) {
  if ([moduleUrl, libraryUrl].includes(context.parentURL)) {
    if (specifier === './env') return { shortCircuit: true, url: envUrl }
    if (specifier === './library') return { shortCircuit: true, url: libraryUrl }
    if (specifier === '../shared/types') return { shortCircuit: true, url: new URL('../src/shared/types.ts', import.meta.url).href }
  }
  return next(specifier, context)
} })
const api = await import(moduleUrl).catch(() => ({}))
hooks.deregister()
const songDir = join(root, 'songs', 'test-song')
mkdirSync(songDir, { recursive: true })
writeFileSync(join(root, 'library.json'), JSON.stringify({ songs: [{ videoId: 'test-song' }] }))
const source = join(songDir, 'mix.wav')
const cache = join(songDir, 'tempo-analysis.json')

test('analyzes the original mix, persists a validated map, and invalidates it when audio changes', async () => {
  assert.equal(typeof api.analyzeSongTempo, 'function')
  writeFileSync(source, JSON.stringify({ points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576, 1.052] }))
  assert.deepEqual(await api.analyzeSongTempo('test-song', 'first', 1), { points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576, 1.052] })
  const saved = JSON.parse(readFileSync(cache, 'utf8'))
  assert.deepEqual(saved.points, [{ start: 0, bpm: 126 }])
  assert.deepEqual(saved.beats, [0.1, 0.576, 1.052])
  assert.deepEqual(await api.analyzeSongTempo('test-song', 'cached', 1), { points: saved.points, beats: saved.beats })
  writeFileSync(cache, JSON.stringify({ ...saved, version: 'librosa-0.11-pulse-4', points: [{ start: 0, bpm: 42 }] }))
  assert.equal((await api.analyzeSongTempo('test-song', 'upgrade', 1)).points[0].bpm, 126)
  writeFileSync(source, JSON.stringify({ points: [{ start: 0, bpm: 135 }, { start: 60, bpm: 160 }], beats: [0.1, 0.544] }))
  assert.deepEqual(await api.analyzeSongTempo('test-song', 'changed', 1), { points: [{ start: 0, bpm: 135 }, { start: 60, bpm: 160 }], beats: [0.1, 0.544] })
  writeFileSync(cache, '{broken')
  assert.equal((await api.analyzeSongTempo('test-song', 'corrupt', 1)).points[0].bpm, 135)
  await assert.rejects(() => api.analyzeSongTempo('../escape', 'invalid', 1), /Unknown song/)
})

test('cancels analysis and rejects malformed output without persisting it', async () => {
  assert.equal(typeof api.cancelSongTempo, 'function')
  rmSync(cache, { force: true })
  writeFileSync(source, JSON.stringify({ delay: 1000, result: { points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576] } }))
  const pending = api.analyzeSongTempo('test-song', 'cancelled', 2)
  const rejected = assert.rejects(pending, /cancel/i)
  api.cancelSongTempo('cancelled', 2)
  await rejected
  assert.equal(existsSync(cache), false)
  for (const points of [[{ start: 0, bpm: 0 }], [{ start: 5, bpm: 126 }], [{ start: 0, bpm: 126 }, { start: -1, bpm: 120 }]]) {
    writeFileSync(source, JSON.stringify({ points, beats: [0.1, 0.576] }))
    await assert.rejects(() => api.analyzeSongTempo('test-song', 'malformed', 2), /Invalid tempo/)
    assert.equal(existsSync(cache), false)
  }
  for (const beats of [[0.5, 0.2], [-1, 0.5], [0.1, null]]) {
    writeFileSync(source, JSON.stringify({ points: [{ start: 0, bpm: 126 }], beats }))
    await assert.rejects(() => api.analyzeSongTempo('test-song', 'invalid-beats', 2), /Invalid tempo/)
    assert.equal(existsSync(cache), false)
  }
})

test('an import retry can replace cancelled analysis while dependencies are still preparing', async () => {
  writeFileSync(source, JSON.stringify({ points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576, 1.052] }))
  rmSync(cache, { force: true })
  let ready
  globalThis.tempoDepsGate = new Promise(resolve => { ready = resolve })
  const old = api.analyzeImportedTempo('test-song')
  const cancelled = assert.rejects(old, /cancel/i)
  api.cancelImportedTempo('test-song')
  const next = api.analyzeImportedTempo('test-song')
  ready()
  await cancelled
  assert.deepEqual(await next, { points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576, 1.052] })
  delete globalThis.tempoDepsGate
})
