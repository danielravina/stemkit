import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-session-'))
after(() => rmSync(root, { recursive: true, force: true }))
const hooks = registerTsHooks({ stubEnv: `export const userDataDir = () => ${JSON.stringify(root)}` })
const { openSession, writeToSession, closeSession } = await import(
  new URL('../src/main/export-session.ts', import.meta.url).href
)
hooks.deregister()

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3])
const noTranscode = async () => assert.fail('transcode must not run for wav')

test('folder session sanitizes the file name and writes identical bytes', async () => {
  const dir = mkdtempSync(join(root, 'folder-'))
  const token = openSession('folder', dir, 'wav')
  const out = await writeToSession(token, 'a/b?', wav, noTranscode)
  assert.equal(out, join(dir, 'a-b-.wav'))
  assert.deepEqual(new Uint8Array(readFileSync(out)), wav)
  closeSession(token)
})

test('file session with aac transcodes then removes the temp wav', async () => {
  const dir = mkdtempSync(join(root, 'file-'))
  const token = openSession('file', join(dir, 'song.wav'), 'aac')
  let tmp = ''
  const out = await writeToSession(token, null, wav, async (src, dest) => {
    tmp = src
    assert.equal(dest, join(dir, 'song.m4a'))
    assert.ok(existsSync(src))
  })
  assert.equal(out, join(dir, 'song.m4a'))
  assert.equal(existsSync(tmp), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('failing transcode cleans the temp wav and propagates', async () => {
  const dir = mkdtempSync(join(root, 'fail-'))
  const token = openSession('file', join(dir, 'song.m4a'), 'aac')
  await assert.rejects(
    writeToSession(token, null, wav, async () => { throw new Error('boom') }),
    /boom/
  )
  assert.deepEqual(readdirSync(dir), [])
})

test('kind and fileName must agree; unknown token rejects', async () => {
  const dir = mkdtempSync(join(root, 'mismatch-'))
  const folder = openSession('folder', dir, 'wav')
  await assert.rejects(writeToSession(folder, null, wav, noTranscode), /file name/i)
  const file = openSession('file', join(dir, 'x.wav'), 'wav')
  await assert.rejects(writeToSession(file, 'x', wav, noTranscode), /file name/i)
  closeSession(folder)
  await assert.rejects(writeToSession(folder, 'x', wav, noTranscode), /Unknown export session/)
  await assert.rejects(writeToSession('nope', 'x', wav, noTranscode), /Unknown export session/)
})

test('the format pinned at begin decides the output, not the caller', async () => {
  const dir = mkdtempSync(join(root, 'pinned-'))
  const token = openSession('folder', dir, 'wav')
  // a stray 5th argument (old signature) must not switch the format
  const out = await writeToSession(token, 'a', wav, noTranscode, 'aac')
  assert.equal(out, join(dir, 'a.wav'))
})
