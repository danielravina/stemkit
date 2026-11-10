import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-pan-'))
after(() => rmSync(root, { recursive: true, force: true }))
const libraryUrl = new URL('../src/main/library.ts', import.meta.url).href
const hooks = registerTsHooks({ stubEnv: `export const userDataDir = () => ${JSON.stringify(root)}` })
const { saveSongs, loadStemPan, saveStemPan, removeSong } = await import(libraryUrl)
hooks.deregister()
const song = { videoId: 'song-one', stems: ['vocals', 'drums'], title: 'Test', duration: 10, addedAt: 1 }

test('pan persists per song, validates values, handles old/corrupt files, and deletes with song', () => {
  saveSongs([song, { ...song, videoId: 'song-two' }])
  mkdirSync(join(root, 'songs', song.videoId), { recursive: true })
  assert.deepEqual(loadStemPan(song.videoId), {})
  saveStemPan(song.videoId, { vocals: -0.5, drums: 3, other: 0.8 })
  assert.deepEqual(loadStemPan(song.videoId), { vocals: -0.5, drums: 1 })
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
