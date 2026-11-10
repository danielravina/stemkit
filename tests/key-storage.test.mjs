import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-key-'))
after(() => rmSync(root, { recursive: true, force: true }))
const src = (f) => new URL(`../src/main/${f}`, import.meta.url).href
const parents = new Set([src('library.ts'), src('keydetect.ts')])
const envStub = `export const userDataDir = () => ${JSON.stringify(root)}
export const venvPython = () => 'python3'
export const keyScript = () => 'key.py'`
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (parents.has(context.parentURL) && specifier === './env') {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(envStub)}` }
    }
    if (parents.has(context.parentURL) && specifier === '../shared/types') {
      return { shortCircuit: true, url: new URL('../src/shared/types.ts', import.meta.url).href }
    }
    if (parents.has(context.parentURL) && specifier === '../shared/keys') {
      return { shortCircuit: true, url: new URL('../src/shared/keys.ts', import.meta.url).href }
    }
    if (context.parentURL === src('keydetect.ts') && specifier === './library') {
      return { shortCircuit: true, url: src('library.ts') }
    }
    if (context.parentURL === src('keydetect.ts') && specifier === './separation-slots') {
      return { shortCircuit: true, url: src('separation-slots.ts') }
    }
    return next(specifier, context)
  }
})
const { saveSongs, loadSongs, patchSongKey, setKeyOverride } = await import(src('library.ts'))
const { keyInputs, detectOnce, withOverride } = await import(src('keydetect.ts'))
hooks.deregister()

const mk = (id) => ({ videoId: id, stems: ['vocals', 'drums', 'bass'], title: id, duration: 10, addedAt: 1 })
const libPath = join(root, 'library.json')

test('patchSongKey rewrites only that song; missing song is a no-op', () => {
  saveSongs([mk('a'), mk('b')])
  const key = { detected: 'Am', confidence: 0.8 }
  const out = patchSongKey('b', key)
  assert.deepEqual(out.key, key)
  const songs = loadSongs()
  assert.deepEqual(songs.find((s) => s.videoId === 'b').key, key)
  assert.equal(songs.find((s) => s.videoId === 'a').key, undefined)
  const before = readFileSync(libPath, 'utf8')
  assert.equal(patchSongKey('missing', key), null)
  assert.equal(readFileSync(libPath, 'utf8'), before)
})

test('setKeyOverride validates, stores and clears while keeping detected', () => {
  saveSongs([{ ...mk('a'), key: { detected: 'Am', confidence: 0.5 } }])
  assert.deepEqual(setKeyOverride('a', 'F♯m'), { detected: 'Am', confidence: 0.5, override: 'F♯m' })
  assert.equal(loadSongs()[0].key.override, 'F♯m')
  assert.throws(() => setKeyOverride('a', 'Zm'), /Unknown key/)
  const cleared = setKeyOverride('a', null)
  assert.equal('override' in cleared, false)
  assert.equal(loadSongs()[0].key.detected, 'Am')
})

test('keyInputs skips drums and falls back to the mix', () => {
  mkdirSync(join(root, 'songs', 'k', 'stems'), { recursive: true })
  for (const s of ['vocals', 'drums', 'bass']) writeFileSync(join(root, 'songs', 'k', 'stems', `${s}.wav`), '')
  assert.deepEqual(keyInputs('k', ['vocals', 'drums', 'bass']), [
    join(root, 'songs', 'k', 'stems', 'vocals.wav'),
    join(root, 'songs', 'k', 'stems', 'bass.wav')
  ])
  assert.deepEqual(keyInputs('k', ['drums']), [join(root, 'songs', 'k', 'mix.wav')])
})

test('detectOnce dedupes concurrent calls, caches, and skips unknown songs', async () => {
  saveSongs([mk('c')])
  mkdirSync(join(root, 'songs', 'c'), { recursive: true })
  let calls = 0
  const run = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return { detected: 'C', confidence: 0.9 }
  }
  const [x, y] = await Promise.all([detectOnce('c', run), detectOnce('c', run)])
  assert.equal(calls, 1)
  assert.deepEqual(x, { detected: 'C', confidence: 0.9 })
  assert.deepEqual(y, x)
  assert.deepEqual(await detectOnce('c', run), x)
  assert.equal(calls, 1)
  assert.deepEqual(await detectOnce('nope', run), { detected: null })
  assert.equal(calls, 1)
})

test('detectOnce attempts once: a failure is stored and never retried', async () => {
  saveSongs([mk('f')])
  mkdirSync(join(root, 'songs', 'f'), { recursive: true })
  let calls = 0
  const run = async () => {
    calls++
    return { detected: null }
  }
  assert.deepEqual(await detectOnce('f', run), { detected: null })
  assert.deepEqual(loadSongs()[0].key, { detected: null })
  assert.deepEqual(await detectOnce('f', run), { detected: null })
  assert.equal(calls, 1)
})

test('an override on a keyless song marks it attempted', async () => {
  saveSongs([mk('g')])
  setKeyOverride('g', 'Am')
  assert.deepEqual(loadSongs()[0].key, { detected: null, override: 'Am' })
  let calls = 0
  await detectOnce('g', async () => (calls++, { detected: 'C' }))
  assert.equal(calls, 0)
})

test('withOverride carries a previous override onto a fresh detection', () => {
  assert.deepEqual(withOverride({ detected: 'C' }, { detected: 'G', override: 'Am' }), { detected: 'C', override: 'Am' })
  assert.deepEqual(withOverride({ detected: 'C' }, { detected: 'G' }), { detected: 'C' })
  assert.deepEqual(withOverride({ detected: 'C' }, undefined), { detected: 'C' })
})
