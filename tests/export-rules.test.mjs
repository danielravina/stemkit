import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIX_ID,
  initialSelection,
  canExport,
  mixedBaseName,
  separateFolderName
} from '../src/shared/export-rules.ts'

const ALL = ['vocals', 'drums', 'bass', 'other']

test('initialSelection takes the soloed stems when there are solos', () => {
  const sel = initialSelection(ALL, new Set(), new Set(['drums', 'bass', 'other']))
  assert.deepEqual([...sel].sort(), ['bass', 'drums', 'other'])
})

test('initialSelection drops muted stems when nothing is soloed', () => {
  const sel = initialSelection(ALL, new Set(['bass']), new Set())
  assert.deepEqual([...sel].sort(), ['drums', 'other', 'vocals'])
})

test('initialSelection never includes the mix id', () => {
  assert.equal(initialSelection([...ALL, MIX_ID], new Set(), new Set()).has(MIX_ID), false)
})

test('canExport needs at least one stem; the mix only counts when separate', () => {
  assert.equal(canExport(new Set(), 'mixed'), false)
  assert.equal(canExport(new Set([MIX_ID]), 'mixed'), false)
  assert.equal(canExport(new Set([MIX_ID]), 'separate'), true)
  assert.equal(canExport(new Set(['drums']), 'mixed'), true)
})

test('mixedBaseName calls everything-but-vocals "instrumental"', () => {
  assert.equal(mixedBaseName('Song', ['drums', 'bass', 'other'], ALL, 0), 'Song - instrumental')
  assert.equal(mixedBaseName('Song', ['drums', 'bass', 'other'], ALL, -3), 'Song - instrumental (-3)')
})

test('mixedBaseName lists stems in allStems order with ASCII signs', () => {
  assert.equal(mixedBaseName('Song', ['bass', 'drums'], ALL, 0), 'Song - drums+bass')
  assert.equal(mixedBaseName('Song', ['bass', 'drums'], ALL, 2), 'Song - drums+bass (+2)')
})

test('mixedBaseName does not say instrumental without a vocals stem', () => {
  assert.equal(mixedBaseName('Song', ['drums', 'bass'], ['drums', 'bass'], 0), 'Song - drums+bass')
})

test('separateFolderName appends the shift only when non-zero', () => {
  assert.equal(separateFolderName('Song', 0), 'Song')
  assert.equal(separateFolderName('Song', 2), 'Song (+2)')
  assert.equal(separateFolderName('Song', -3), 'Song (-3)')
})

test('long titles are cut so the stem and shift suffix survive a 120-char name limit', () => {
  const title = 'x'.repeat(200)
  const mixed = mixedBaseName(title, ['drums', 'bass'], ALL, 2)
  assert.ok(mixed.length <= 120, `length ${mixed.length}`)
  assert.ok(mixed.endsWith(' - drums+bass (+2)'))
  assert.equal(mixed, `${'x'.repeat(102)} - drums+bass (+2)`)
  assert.equal(separateFolderName(title, -1), `${'x'.repeat(115)} (-1)`)
  // short titles are untouched
  assert.equal(separateFolderName('Song', 0), 'Song')
})

test('the suffix survives even with every stem of a 6-stem song checked and a shift', () => {
  const six = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
  const name = mixedBaseName('y'.repeat(200), six, six, -6)
  assert.ok(name.length <= 120, `length ${name.length}`)
  assert.ok(name.endsWith(' - vocals+drums+bass+guitar+piano+other (-6)'))
})
