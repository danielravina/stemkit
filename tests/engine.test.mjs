import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// renderer modules use extensionless relative imports (bundler resolution);
// node needs the .ts spelled out
const srcRoot = new URL('../src/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(srcRoot) && specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href }
    }
    return next(specifier, context)
  }
})
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
      playbackRate: new Param(), stopped: false, start() {}, stop() { this.stopped = true }
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

test('non-zero pitch routes master through the shifter and offsets the clock', async () => {
  const { calls, factory } = instant()
  const { engine, ctx, master } = playing(factory)
  await engine.setPitch(-3)
  const { shifter } = calls[0]
  assert.equal(master.outputs.length, 1)
  assert.equal(master.outputs[0], shifter.input)
  assert.deepEqual(shifter.output.outputs, [ctx.destination])
  assert.equal(shifter.semitones.at(-1), -3)
  assert.equal(engine.pitch(), -3)
  // re-aligned at the same position: the clock holds while the shifter's
  // latency drains, then advances in step with currentTime
  const startAt = ctx.currentTime + 0.04
  assert.equal(engine.expected(), 5)
  ctx.currentTime = startAt + 0.05 - 0.01
  assert.equal(engine.expected(), 5)
  ctx.currentTime = startAt + 0.05 + 1
  assert.ok(Math.abs(engine.expected() - 6) < 1e-9)
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

test('pitch set before the audio context exists applies once playback starts', async () => {
  const { calls, factory } = instant()
  const engine = new StemEngine(factory)
  engine.setBuffers(buffers)
  await engine.setPitch(-2)
  assert.equal(calls.length, 0)
  engine.setPlaying(true, 0)
  await new Promise((r) => setTimeout(r, 0))
  // the re-route restarted the sources: read the graph from the live ones
  const master = nodes(Context.last.sources.at(-1)).master
  assert.equal(master.outputs[0], calls[0].shifter.input)
  assert.equal(engine.pitch(), -2)
})
