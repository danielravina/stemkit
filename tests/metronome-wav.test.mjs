import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMetronomeWav } from '../src/main/metronome-wav.ts'
import { clickSamples, CLICK_GAIN, CLICK_SAMPLE_RATE, manualBeats, metronomePeaks } from '../src/shared/metronome.ts'

test('metronome WAV spans the exact song duration and puts clicks on the supplied beat times', () => {
  const duration = 2.125
  const bytes = renderMetronomeWav([0.125, 0.625, 1.125, 1.625, 2.125], duration)
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  assert.equal(bytes.readUInt16LE(22), 1)
  assert.equal(bytes.readUInt32LE(24), CLICK_SAMPLE_RATE)
  assert.equal(bytes.readUInt16LE(34), 16)
  assert.equal(bytes.length, 44 + Math.ceil(duration * CLICK_SAMPLE_RATE) * 2)
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44)
  assert.ok(bytes.subarray(44, 44 + Math.round(0.125 * CLICK_SAMPLE_RATE) * 2).every(byte => byte === 0))
  const click = clickSamples(false)
  for (const beat of [0.125, 0.625, 1.125, 1.625]) {
    const first = Math.round(beat * CLICK_SAMPLE_RATE)
    for (let i = 0; i < click.length; i++) {
      assert.equal(bytes.readInt16LE(44 + (first + i) * 2), (Math.round(click[i] * CLICK_GAIN * 32767) || 0))
    }
  }
})

test('manual metronome export keeps fractional BPM and clips the final click at song end', () => {
  const duration = 0.51
  const beats = manualBeats(120, duration)
  assert.deepEqual(beats, [0, 0.5])
  const bytes = renderMetronomeWav(beats, duration)
  assert.equal(bytes.length, 44 + Math.ceil(duration * CLICK_SAMPLE_RATE) * 2)
  assert.ok(bytes.readInt16LE(44 + (Math.round(0.5 * CLICK_SAMPLE_RATE) + 1) * 2) !== 0)
  assert.equal(manualBeats(69.5, 10)[1], 60 / 69.5)
})

test('metronome WAV rejects invalid duration and beat timestamps', () => {
  for (const duration of [0, -1, NaN, Infinity, 1e10]) assert.throws(() => renderMetronomeWav([0], duration))
  for (const beats of [[-1], [NaN], [Infinity], [0.5, 0.4], [0.5, 0.5], []]) {
    assert.throws(() => renderMetronomeWav(beats, 1))
  }
})


test('waveform peaks show real clicks and silence on the song timeline', () => {
  const peaks = metronomePeaks([0.5, 1.5], 2, 200)
  assert.equal(peaks.length, 200)
  assert.equal(peaks[10], 0)
  assert.ok(peaks[50] > 0.9)
  assert.ok(peaks[150] > 0.9)
  assert.equal(peaks[100], 0)
  assert.ok(metronomePeaks([], 2, 200).every(value => value === 0))
  assert.ok(metronomePeaks([0.5], 0, 200).every(value => value === 0))
})
