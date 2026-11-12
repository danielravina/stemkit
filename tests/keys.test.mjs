import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY_NAMES, keyName, parseKey, transposeKey, formatShift } from '../src/shared/keys.ts'

test('keyName maps tonic and mode to the display name', () => {
  assert.equal(keyName(9, 'minor'), 'Am')
  assert.equal(keyName(6, 'major'), 'F♯')
})

test('parseKey accepts only the 24 table names', () => {
  assert.deepEqual(parseKey('B♭m'), { tonic: 10, mode: 'minor' })
  assert.equal(parseKey('H'), null)
})

test('KEY_NAMES has 24 unique names', () => {
  assert.equal(KEY_NAMES.length, 24)
  assert.equal(new Set(KEY_NAMES).size, 24)
})

test('transposeKey shifts by semitones modulo 12', () => {
  assert.equal(transposeKey('Am', -3), 'F♯m')
  assert.equal(transposeKey('C', 14), 'D')
  assert.equal(transposeKey('Am', 0), 'Am')
  assert.equal(transposeKey('nope', 1), null)
})

test('formatShift signs the shift with a real minus', () => {
  assert.equal(formatShift(-3), '\u22123')
  assert.equal(formatShift(2), '+2')
  assert.equal(formatShift(0), '0')
})
