import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'

const hooks = registerTsHooks()
const { StemEngine } = await import('../src/renderer/src/lib/engine.ts')
hooks.deregister()

class Param {
  value = 0
  setTargetAtTime(value) { this.value = value }
}
class AudioNode {
  outputs = []
  connect(node) { this.outputs.push(node) }
  disconnect() { this.outputs = [] }
}
class Context {
  static last
  currentTime = 1
  destination = new AudioNode()
  sources = []
  constructor() { Context.last = this }
  createGain() { return Object.assign(new AudioNode(), { gain: new Param() }) }
  createStereoPanner() { return Object.assign(new AudioNode(), { pan: new Param() }) }
  createBufferSource() {
    const node = Object.assign(new AudioNode(), {
      playbackRate: new Param(), stopped: false, started: null,
      start(...args) { this.started = args }, stop() { this.stopped = true }
    })
    this.sources.push(node)
    return node
  }
  async resume() {}
}
globalThis.AudioContext = Context
const buffers = { vocals: { duration: 10 }, drums: { duration: 10 } }
const nodes = (source) => {
  const gain = source.outputs[0]
  const pan = gain.outputs[0]
  return { gain, pan, master: pan.outputs[0] }
}

test('saved mix applies on first playback and pan stays independent of mute/solo', () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.applyMix({ vocals: 0.4, drums: 0.8 }, new Set(), new Set(['vocals']), 0.6, { vocals: -1, drums: 1 })
  engine.setPlaying(true, 0)
  const [voice, drums] = Context.last.sources.map(nodes)
  assert.equal(voice.pan.pan.value, -1)
  assert.equal(drums.pan.pan.value, 1)
  assert.equal(voice.gain.gain.value, 0.4)
  assert.equal(drums.gain.gain.value, 0)
  assert.equal(voice.master.gain.value, 0.6)
  engine.applyMix({ vocals: 0.4, drums: 0.8 }, new Set(['vocals']), new Set(), 0.6, { vocals: 0, drums: 1 })
  assert.equal(voice.pan.pan.value, 0)
  assert.equal(drums.pan.pan.value, 1)
  assert.equal(voice.gain.gain.value, 0)
  assert.equal(drums.gain.gain.value, 0.8)
})

test('seeking and resume preserve pan; switching songs disconnects and resets it', () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.applyMix({}, new Set(), new Set(), 0.9, { vocals: 0.55 })
  engine.setPlaying(true, 0)
  const original = nodes(Context.last.sources[0])
  engine.align(4)
  assert.equal(nodes(Context.last.sources[2]).pan, original.pan)
  engine.setPlaying(false, 4)
  engine.setPlaying(true, 4)
  assert.equal(nodes(Context.last.sources[4]).pan.pan.value, 0.55)
  engine.setBuffers(buffers)
  assert.deepEqual(original.pan.outputs, [])
  engine.setPlaying(true, 0)
  assert.equal(nodes(Context.last.sources[6]).pan.pan.value, 0)
})

// controllable fake: each factory call returns a pending promise the test settles
const fakeFactory = () => {
  const calls = []
  const factory = (ctx) => new Promise((resolve, reject) => {
    const shifter = {
      input: new AudioNode(),
      output: new AudioNode(),
      latency: 0.05,
      semitones: [],
      setSemitones(n) { this.semitones.push(n) },
      dispose() {}
    }
    calls.push({ ctx, shifter, resolve: () => resolve(shifter), reject })
  })
  return { factory, calls }
}
const instant = () => {
  const fake = fakeFactory()
  return {
    calls: fake.calls,
    factory: (ctx) => {
      const p = fake.factory(ctx)
      fake.calls.at(-1).resolve()
      return p
    }
  }
}
const playing = (factory) => {
  const engine = new StemEngine(factory)
  engine.setBuffers(buffers)
  engine.setPlaying(true, 5)
  return { engine, ctx: Context.last, master: nodes(Context.last.sources[0]).master }
}

test('pitch 0 keeps master wired straight to destination', () => {
  const { calls, factory } = instant()
  const { engine, ctx, master } = playing(factory)
  assert.deepEqual(master.outputs, [ctx.destination])
  assert.equal(calls.length, 0)
  assert.equal(engine.pitch(), 0)
})

test('non-zero pitch routes master through the shifter and jumps the clock ahead', async () => {
  const { calls, factory } = instant()
  const { engine, ctx, master } = playing(factory)
  // mid-playback: 1 s after the first sample became audible
  ctx.currentTime = 1.04 + 1
  assert.ok(Math.abs(engine.expected() - 6) < 1e-9)
  await engine.setPitch(-3)
  const { shifter } = calls[0]
  assert.equal(master.outputs.length, 1)
  assert.equal(master.outputs[0], shifter.input)
  assert.deepEqual(shifter.output.outputs, [ctx.destination])
  assert.equal(shifter.semitones.at(-1), -3)
  assert.equal(engine.pitch(), -3)
  // re-aligned ahead by the start delay plus the shifter's latency, so the
  // position is where the video will be once the new path is audible
  const audibleAt = ctx.currentTime + 0.04 + 0.05
  assert.ok(Math.abs(engine.expected() - (6 + 0.09)) < 1e-9)
  const [src] = ctx.sources.slice(-2)
  assert.ok(src.started && Math.abs(src.started[1] - 6.09) < 1e-9, 'sources resume ahead')
  ctx.currentTime = audibleAt + 1
  assert.ok(Math.abs(engine.expected() - 7.09) < 1e-9)
})

test('a 0 -> n -> 0 round trip while playing does not leave the clock behind the wall clock', async () => {
  const { factory } = instant()
  const { engine, ctx } = playing(factory)
  const audibleAt = ctx.currentTime + 0.04
  ctx.currentTime = 2
  await engine.setPitch(3)
  ctx.currentTime = 3
  await engine.setPitch(0)
  ctx.currentTime = 4
  const wall = 5 + (ctx.currentTime - audibleAt)
  assert.ok(Math.abs(engine.expected() - wall) < 0.005, `expected ${engine.expected()} ~ ${wall}`)
})

test('back to 0 restores bypass', async () => {
  const { calls, factory } = instant()
  const { engine, ctx, master } = playing(factory)
  await engine.setPitch(2)
  const routed = Context.last.sources.slice()
  await engine.setPitch(0)
  assert.deepEqual(master.outputs, [ctx.destination])
  assert.deepEqual(calls[0].shifter.output.outputs, [])
  assert.ok(routed.every((s) => s.stopped))
  assert.equal(engine.pitch(), 0)
  await engine.setPitch(4)
  assert.equal(calls.length, 1, 'the shifter is created once and reused')
  assert.equal(master.outputs[0], calls[0].shifter.input)
})

test('rapid presses while the factory is pending create one shifter and end at the last value', async () => {
  const { calls, factory } = fakeFactory()
  const { engine, master } = playing(factory)
  const pending = [engine.setPitch(1), engine.setPitch(2), engine.setPitch(3)]
  assert.equal(calls.length, 1)
  calls[0].resolve()
  await Promise.all(pending)
  assert.equal(calls.length, 1)
  assert.equal(engine.pitch(), 3)
  assert.equal(calls[0].shifter.semitones.at(-1), 3)
  assert.deepEqual(master.outputs, [calls[0].shifter.input])
})

test('returning to 0 while the factory is pending stays in bypass', async () => {
  const { calls, factory } = fakeFactory()
  const { engine, ctx, master } = playing(factory)
  const pending = [engine.setPitch(2), engine.setPitch(0)]
  calls[0].resolve()
  await Promise.all(pending)
  assert.equal(engine.pitch(), 0)
  assert.deepEqual(master.outputs, [ctx.destination])
})

test('factory failure leaves audio in bypass', async () => {
  const { calls, factory } = fakeFactory()
  const { engine, ctx, master } = playing(factory)
  const pending = engine.setPitch(2)
  calls[0].reject(new Error('Pitch shifter failed to load'))
  await assert.doesNotReject(pending)
  assert.deepEqual(master.outputs, [ctx.destination])
  assert.equal(engine.pitch(), 0)
  assert.equal(engine.pitchError, 'Pitch shifter failed to load')
})

test('pitch set before the audio context exists loads the shifter while paused', async () => {
  const { calls, factory } = instant()
  const engine = new StemEngine(factory)
  engine.setBuffers(buffers)
  await engine.setPitch(-2)
  assert.equal(calls.length, 1, 'the shifter loads before the first play')
  assert.equal(engine.pitch(), -2)
  const ctx = Context.last
  engine.setPlaying(true, 0)
  await new Promise((r) => setTimeout(r, 0))
  // routed from the first align: no re-route restarted the sources
  assert.equal(ctx.sources.length, 2)
  assert.ok(ctx.sources.every((s) => !s.stopped))
  const master = nodes(ctx.sources[0]).master
  assert.deepEqual(master.outputs, [calls[0].shifter.input])
  assert.equal(calls.length, 1)
})

test('returning to 0 clears a previous load error', async () => {
  const { calls, factory } = fakeFactory()
  const { engine } = playing(factory)
  const first = engine.setPitch(2)
  calls[0].reject(new Error('Pitch shifter failed to load'))
  await first
  assert.equal(engine.pitchError, 'Pitch shifter failed to load')
  await engine.setPitch(0)
  assert.equal(engine.pitchError, null)
})

test('a failed load can be retried by pressing again', async () => {
  const { calls, factory } = fakeFactory()
  const { engine, master } = playing(factory)
  const first = engine.setPitch(2)
  calls[0].reject(new Error('Pitch shifter failed to load'))
  await first
  assert.equal(engine.pitchError, 'Pitch shifter failed to load')
  const second = engine.setPitch(2)
  assert.equal(calls.length, 2, 'the factory is called again')
  calls[1].resolve()
  await second
  assert.equal(engine.pitchError, null)
  assert.equal(engine.pitch(), 2)
  assert.deepEqual(master.outputs, [calls[1].shifter.input])
})
