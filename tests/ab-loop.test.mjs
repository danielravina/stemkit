import { test } from 'node:test'
import assert from 'node:assert/strict'

const MIN_LOOP_DURATION = 0.2

function createLoopController() {
  let loopA = null
  let loopB = null
  let isLoopActive = false
  let currentPos = 0

  return {
    setPos(p) { currentPos = p },
    getPos() { return currentPos },
    getA() { return loopA },
    getB() { return loopB },
    isActive() { return isLoopActive },
    setPointA() {
      const pos = currentPos
      if (loopB === null) {
        loopA = pos
        return
      }
      if (pos >= loopB) {
        const newA = loopB
        const newB = Math.max(pos, newA + MIN_LOOP_DURATION)
        loopA = newA
        loopB = newB
        isLoopActive = true
      } else {
        const newA = pos
        const newB = Math.max(loopB, newA + MIN_LOOP_DURATION)
        loopA = newA
        loopB = newB
        isLoopActive = true
      }
    },
    setPointB() {
      const pos = currentPos
      if (loopA === null) {
        loopA = pos
        return
      }
      if (pos <= loopA) {
        const newA = pos
        const newB = Math.max(loopA, newA + MIN_LOOP_DURATION)
        loopA = newA
        loopB = newB
        isLoopActive = true
      } else {
        const newB = Math.max(pos, loopA + MIN_LOOP_DURATION)
        loopB = newB
        isLoopActive = true
      }
    },
    toggleLoop() {
      if (loopA !== null && loopB !== null) {
        isLoopActive = !isLoopActive
      }
    },
    clearLoop() {
      loopA = null
      loopB = null
      isLoopActive = false
    },
    checkTick() {
      if (isLoopActive && loopA !== null && loopB !== null && currentPos >= loopB) {
        currentPos = loopA
        return true
      }
      return false
    }
  }
}

test('A-B Loop: setting A first, then B enables loop', () => {
  const ctrl = createLoopController()
  ctrl.setPos(10.5)
  ctrl.setPointA()
  assert.equal(ctrl.getA(), 10.5)
  assert.equal(ctrl.getB(), null)
  assert.equal(ctrl.isActive(), false)

  ctrl.setPos(20.0)
  ctrl.setPointB()
  assert.equal(ctrl.getA(), 10.5)
  assert.equal(ctrl.getB(), 20.0)
  assert.equal(ctrl.isActive(), true)
})

test('A-B Loop: setting B when A is null sets A instead', () => {
  const ctrl = createLoopController()
  ctrl.setPos(15.0)
  ctrl.setPointB()
  assert.equal(ctrl.getA(), 15.0)
  assert.equal(ctrl.getB(), null)
  assert.equal(ctrl.isActive(), false)
})

test('A-B Loop: auto-swaps when setting B earlier than A', () => {
  const ctrl = createLoopController()
  ctrl.setPos(30.0)
  ctrl.setPointA()

  ctrl.setPos(12.0)
  ctrl.setPointB()
  // B was 12.0 (< 30.0), so 12 becomes A, 30 becomes B
  assert.equal(ctrl.getA(), 12.0)
  assert.equal(ctrl.getB(), 30.0)
  assert.equal(ctrl.isActive(), true)
})

test('A-B Loop: enforces minimum 0.2s duration', () => {
  const ctrl = createLoopController()
  ctrl.setPos(10.0)
  ctrl.setPointA()

  ctrl.setPos(10.05) // delta = 0.05s
  ctrl.setPointB()
  assert.equal(ctrl.getA(), 10.0)
  assert.equal(ctrl.getB(), 10.2) // adjusted to +0.2s
  assert.equal(ctrl.isActive(), true)
})

test('A-B Loop: tick wraps back to A when reaching or passing B', () => {
  const ctrl = createLoopController()
  ctrl.setPos(5.0)
  ctrl.setPointA()
  ctrl.setPos(10.0)
  ctrl.setPointB()

  ctrl.setPos(8.0)
  assert.equal(ctrl.checkTick(), false)
  assert.equal(ctrl.getPos(), 8.0)

  ctrl.setPos(10.0)
  assert.equal(ctrl.checkTick(), true)
  assert.equal(ctrl.getPos(), 5.0) // looped back to A!
})

test('A-B Loop: toggle and clear loop functionality', () => {
  const ctrl = createLoopController()
  ctrl.setPos(2.0)
  ctrl.setPointA()
  ctrl.setPos(6.0)
  ctrl.setPointB()
  assert.equal(ctrl.isActive(), true)

  ctrl.toggleLoop()
  assert.equal(ctrl.isActive(), false)

  ctrl.toggleLoop()
  assert.equal(ctrl.isActive(), true)

  ctrl.clearLoop()
  assert.equal(ctrl.getA(), null)
  assert.equal(ctrl.getB(), null)
  assert.equal(ctrl.isActive(), false)
})
