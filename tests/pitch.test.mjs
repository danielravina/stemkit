import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PITCH_MIN, PITCH_MAX, clampPitch } from '../src/shared/pitch-range.ts'

test('pitch range is ±6 semitones', () => {
  assert.equal(PITCH_MIN, -6)
  assert.equal(PITCH_MAX, 6)
})

test('clampPitch clamps to the range', () => {
  assert.equal(clampPitch(-7), -6)
  assert.equal(clampPitch(99), 6)
})

test('clampPitch rounds to an integer', () => {
  assert.equal(clampPitch(2.6), 3)
  assert.equal(clampPitch(-0.4), 0)
  assert.ok(Object.is(clampPitch(-0.4), 0))
})

test('clampPitch maps non-numeric and non-finite input to 0', () => {
  assert.equal(clampPitch('x'), 0)
  assert.equal(clampPitch(NaN), 0)
  assert.equal(clampPitch(Infinity), 0)
  assert.equal(clampPitch(undefined), 0)
})
