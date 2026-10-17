import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-pan-'))
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
    return next(specifier, context)
  }
})
const { saveSongs, loadStemPan, saveStemPan, removeSong, loadTempoSettings, saveTempoSettings } = await import(libraryUrl)
hooks.deregister()
const song = { videoId: 'song-one', stems: ['vocals', 'drums'], title: 'Test', duration: 10, addedAt: 1 }

test('tempo settings persist, default safely, reject invalid input, and cannot recreate a deleted song', () => {
  assert.equal(typeof loadTempoSettings, 'function')
  saveSongs([song, { ...song, videoId: 'song-two' }])
  mkdirSync(join(root, 'songs', song.videoId), { recursive: true })
  assert.deepEqual(loadTempoSettings(song.videoId), { mode: 'auto', manualBpm: null, beatsPerBar: 4 })
  saveTempoSettings(song.videoId, { mode: 'manual', manualBpm: 135, beatsPerBar: 3 })
  assert.deepEqual(loadTempoSettings(song.videoId), { mode: 'manual', manualBpm: 135, beatsPerBar: 3 })
  saveTempoSettings(song.videoId, { mode: 'manual', manualBpm: 100, sourceBpm: 150, beatsPerBar: 3 })
  assert.equal(loadTempoSettings(song.videoId).sourceBpm, 150)
  for (const sourceBpm of [NaN, 0, 301, '150']) {
    assert.throws(() => saveTempoSettings(song.videoId, { mode: 'manual', manualBpm: 100, sourceBpm, beatsPerBar: 3 }))
  }
  assert.equal(loadTempoSettings('song-two').mode, 'auto')
  for (const patch of [{ manualBpm: NaN }, { manualBpm: 301 }, { manualBpm: 29 }, { manualBpm: null }, { beatsPerBar: 0 }, { beatsPerBar: 13 }, { beatsPerBar: 2.5 }, { mode: 'x' }]) {
    assert.throws(() => saveTempoSettings(song.videoId, { mode: 'manual', manualBpm: 120, beatsPerBar: 4, ...patch }))
  }
  assert.throws(() => saveTempoSettings(song.videoId, null))
  writeFileSync(join(root, 'songs', song.videoId, 'tempo.json'), '{broken')
  assert.equal(loadTempoSettings(song.videoId).beatsPerBar, 4)
  assert.throws(() => loadTempoSettings('../escape'), /Unknown song/)
  removeSong(song.videoId)
  assert.throws(() => saveTempoSettings(song.videoId, { beatsPerBar: 4 }), /Unknown song/)
})

test('pan persists per song, validates values, handles old/corrupt files, and deletes with song', () => {
  saveSongs([song, { ...song, videoId: 'song-two' }])
  mkdirSync(join(root, 'songs', song.videoId), { recursive: true })
  assert.deepEqual(loadStemPan(song.videoId), {})
  saveStemPan(song.videoId, { vocals: -0.5, drums: 3, other: 0.8, metronome: -2 })
  assert.deepEqual(loadStemPan(song.videoId), { vocals: -0.5, drums: 1, metronome: -1 })
  assert.deepEqual(loadStemPan('song-two'), {})
  saveStemPan(song.videoId, { vocals: NaN, drums: 'left' })
  assert.deepEqual(loadStemPan(song.videoId), {})
  writeFileSync(join(root, 'songs', song.videoId, 'pan.json'), '{broken')
  assert.deepEqual(loadStemPan(song.videoId), {})
  assert.throws(() => saveStemPan('../escape', {}), /Unknown song/)
  removeSong(song.videoId)
  assert.equal(existsSync(join(root, 'songs', song.videoId)), false)
  assert.throws(() => saveStemPan(song.videoId, { vocals: 1 }), /Unknown song/)
  assert.equal(existsSync(join(root, 'songs', song.videoId)), false)
})
