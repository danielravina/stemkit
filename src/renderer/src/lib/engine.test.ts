import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StemEngine } from './engine.ts'

test('expected() wraps inside the A-B loop', () => {
  const e = new StemEngine() as any
  e.ctx = { currentTime: 0 }
  e.playing = true
  e.loop = { start: 10, end: 14 }
  e.anchorYt = 12
  e.anchorCtx = 0
  e.ctx.currentTime = 1 // 13s, still inside
  assert.equal(e.expected(), 13)
  e.ctx.currentTime = 3 // 15s raw -> wraps to 11s
  assert.equal(e.expected(), 11)
  e.ctx.currentTime = 10 // 22s raw -> 10 + (12 % 4)
  assert.equal(e.expected(), 10)
  e.loop = null
  assert.equal(e.expected(), 22)
})
