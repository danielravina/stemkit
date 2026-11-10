import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-pitch-'))
after(() => rmSync(root, { recursive: true, force: true }))
const libraryUrl = new URL('../src/main/library.ts', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === libraryUrl && specifier === './env') {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export const userDataDir = () => ${JSON.stringify(root)}`)}` }
    }
    if (context.parentURL === libraryUrl && specifier === '../shared/types') {
      return { shortCircuit: true, url: new URL('../src/shared/types.ts', import.meta.url).href }
    }
    if (context.parentURL === libraryUrl && specifier === '../shared/keys') {
      return { shortCircuit: true, url: new URL('../src/shared/keys.ts', import.meta.url).href }
    }
    if (context.parentURL === libraryUrl && specifier === '../shared/pitch-range') {
      return { shortCircuit: true, url: new URL('../src/shared/pitch-range.ts', import.meta.url).href }
    }
    return next(specifier, context)
  }
})
const { saveSongs, loadPitch, savePitch, removeSong } = await import(libraryUrl)
hooks.deregister()
const song = { videoId: 'song-one', stems: ['vocals', 'drums'], title: 'Test', duration: 10, addedAt: 1 }

test('pitch persists per song, clamps, tolerates missing/corrupt files, deletes with song', () => {
  saveSongs([song, { ...song, videoId: 'song-two' }])
  mkdirSync(join(root, 'songs', song.videoId), { recursive: true })
  assert.equal(loadPitch(song.videoId), 0)
  savePitch(song.videoId, -3)
  assert.equal(loadPitch(song.videoId), -3)
  assert.equal(loadPitch('song-two'), 0)
  writeFileSync(join(root, 'songs', song.videoId, 'pitch.json'), '{"semitones":40}')
  assert.equal(loadPitch(song.videoId), 6)
  writeFileSync(join(root, 'songs', song.videoId, 'pitch.json'), '{broken')
  assert.equal(loadPitch(song.videoId), 0)
  assert.throws(() => savePitch('../escape', 1), /Unknown song/)
  assert.throws(() => loadPitch('../escape'), /Unknown song/)
  removeSong(song.videoId)
  assert.equal(existsSync(join(root, 'songs', song.videoId)), false)
  assert.throws(() => savePitch(song.videoId, 2), /Unknown song/)
  assert.equal(existsSync(join(root, 'songs', song.videoId)), false)
})
