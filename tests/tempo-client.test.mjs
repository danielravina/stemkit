import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TempoDetector, tempoAt, manualBeats, practiceRate, playbackAnalysis } from '../src/renderer/src/lib/tempo-client.ts'

test('uses one stable song analysis across positions while preserving sustained tempo changes', async () => {
  const calls = []
  globalThis.window = { stemkit: {
    analyzeTempo: async (id) => { calls.push(id); return id === 'steady' ? { points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576] } : { points: [{ start: 0, bpm: 90 }, { start: 60, bpm: 150 }], beats: [0.1, 0.766] } },
    cancelTempoAnalysis: async () => {}
  } }
  const detector = new TempoDetector()
  for (const position of [0, 30, 90, 180, 230]) assert.equal(await detector.detect('steady', position), 126)
  assert.deepEqual(calls, ['steady'])
  assert.deepEqual((await detector.analyze('steady')).beats, [0.1, 0.576])
  assert.equal(await detector.detect('changing', 5), 90)
  assert.equal(await detector.detect('changing', 90), 150)
  assert.equal(tempoAt([], 0), null)
})

test('manual metronome stays on one song-wide grid after seeking', () => {
  assert.deepEqual(manualBeats(120, 1.25), [0, 0.5, 1])
  assert.deepEqual(manualBeats(60, 3), [0, 1, 2])
  assert.deepEqual(manualBeats(NaN, 10), [])
  assert.deepEqual(manualBeats(0, 10), [])
})

test('cancel rejects immediately, cancels the Python request, and discards stale results', async () => {
  let resolve
  const cancelled = []
  globalThis.window = { stemkit: {
    analyzeTempo: () => new Promise(done => { resolve = done }),
    cancelTempoAnalysis: async (id) => { cancelled.push(id) }
  } }
  const detector = new TempoDetector()
  const pending = detector.detect('song', 0)
  const rejection = assert.rejects(pending, { name: 'AbortError' })
  detector.cancel()
  await rejection
  assert.equal(cancelled.length, 1)
  resolve({ points: [{ start: 0, bpm: 42 }], beats: [0.1] })
  await Promise.resolve()
  window.stemkit.analyzeTempo = async () => ({ points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576] })
  assert.equal(await detector.detect('song', 0), 126)
})

test('practice ratio keeps an edited section baseline across seeks and supports legacy settings', () => {
  const analysis = { points: [{ start: 0, bpm: 90 }, { start: 24, bpm: 150 }], beats: [0.1] }
  assert.equal(practiceRate({ mode: 'manual', manualBpm: 100, sourceBpm: 150 }, analysis), 2 / 3)
  assert.equal(practiceRate({ mode: 'manual', manualBpm: 60 }, analysis), 2 / 3)
  assert.equal(practiceRate({ mode: 'auto' }, analysis), 1)
  assert.equal(practiceRate({ mode: 'manual', manualBpm: 100 }, { points: [], beats: [] }), 1)
})

test('failed detection permits manual fallback, but cancellation and auto failures still propagate', async () => {
  const detector = new TempoDetector()
  globalThis.window = { stemkit: { analyzeTempo: async () => { throw new Error('Missing original mix') }, cancelTempoAnalysis: async () => {} } }
  assert.deepEqual(await playbackAnalysis(detector, 'missing', true), { points: [], beats: [] })
  await assert.rejects(playbackAnalysis(detector, 'missing', false), /Missing original mix/)
  window.stemkit.analyzeTempo = async () => { throw new DOMException('Cancelled', 'AbortError') }
  await assert.rejects(playbackAnalysis(detector, 'cancel', true), { name: 'AbortError' })
})
