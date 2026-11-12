import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-export-'))
after(() => rmSync(root, { recursive: true, force: true }))
const hooks = registerTsHooks({ stubEnv: `export const userDataDir = () => ${JSON.stringify(root)}` })
const { wavDuration } = await import(new URL('../src/main/library.ts', import.meta.url).href)
const { encodeWavF32 } = await import(new URL('../src/shared/wav.ts', import.meta.url).href)
const { renderLength, trimLatency, limitPeak } = await import(
  new URL('../src/renderer/src/lib/render-math.ts', import.meta.url).href
)
hooks.deregister()

test('encodeWavF32 writes a float32 RIFF file that wavDuration and a reader accept', () => {
  const left = Float32Array.from([0.25, -0.5, 1])
  const right = Float32Array.from([0, 0.5, -1])
  const bytes = encodeWavF32([left, right], 44100)
  assert.equal(bytes.length, 44 + 24)
  const file = join(root, 'a.wav')
  writeFileSync(file, bytes)
  // wavDuration returns whole seconds, so check it on a 2 s file rather than the 3-sample one
  const long = join(root, 'long.wav')
  writeFileSync(long, encodeWavF32([new Float32Array(88200), new Float32Array(88200)], 44100))
  assert.equal(wavDuration(long), 2)
  const buf = readFileSync(file)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.readUInt32LE(4), buf.length - 8)
  assert.equal(buf.readUInt32LE(16), 16)
  assert.equal(buf.readUInt16LE(20), 3)
  assert.equal(buf.readUInt16LE(22), 2)
  assert.equal(buf.readUInt32LE(24), 44100)
  assert.equal(buf.readUInt32LE(28), 44100 * 8)
  assert.equal(buf.readUInt16LE(32), 8)
  assert.equal(buf.readUInt16LE(34), 32)
  assert.equal(buf.toString('ascii', 36, 40), 'data')
  assert.equal(buf.readUInt32LE(40), 24)
  const got = []
  for (let i = 0; i < 6; i++) got.push(buf.readFloatLE(44 + i * 4))
  assert.deepEqual(got, [0.25, 0, -0.5, 0.5, 1, -1])
})

test('renderLength rounds the longest duration up to whole samples', () => {
  assert.equal(renderLength([10, 10.02], 44100), 441882)
})

test('trimLatency drops leading latency and zero-pads a short tail', () => {
  const ch = [Float32Array.from([0, 0, 1, 2, 3, 4])]
  assert.deepEqual(Array.from(trimLatency(ch, 2, 3)[0]), [1, 2, 3])
  assert.deepEqual(Array.from(trimLatency(ch, 2, 5)[0]), [1, 2, 3, 4, 0])
})

test('limitPeak scales only when the peak exceeds 1', () => {
  const loud = [Float32Array.from([2, -1]), Float32Array.from([0.5, 0])]
  const gain = limitPeak(loud)
  assert.ok(Math.abs(gain - 0.98855 / 2) < 1e-6)
  assert.ok(Math.abs(loud[0][0] - 0.98855) < 1e-6)
  const quiet = [Float32Array.from([0.5, -0.25])]
  assert.equal(limitPeak(quiet), 1)
  assert.deepEqual(Array.from(quiet[0]), [0.5, -0.25])
})
