import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEY_NAMES, keyName, parseKey } from '../src/shared/keys.ts'

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
