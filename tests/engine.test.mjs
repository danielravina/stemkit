import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StemEngine } from '../src/renderer/src/lib/engine.ts'

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
    const node = Object.assign(new AudioNode(), { playbackRate: new Param(), start(...args) { this.started = args }, stop() { this.stopped = true } })
    this.sources.push(node)
    return node
  }
  createBuffer(channels, length, sampleRate) {
    const samples = new Float32Array(length)
    return { duration: length / sampleRate, getChannelData: () => samples }
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

test('count-in schedules accented clicks and stems on one clock, holding song position', async () => {
  for (const bars of [1, 2, 3, 4]) {
    const engine = new StemEngine()
    engine.setBuffers(buffers)
    engine.applyMix({}, new Set(['drums']), new Set(), 0.6)
    await engine.start(3, { bars, bpm: 120, beatsPerBar: 4 })
    const ctx = Context.last
    const clicks = ctx.sources.filter((s) => s.buffer.duration < 0.1)
    const stems = ctx.sources.filter((s) => s.buffer.duration === 10)
    assert.equal(clicks.length, bars * 4)
    assert.equal(clicks[0].started[0], 1.04)
    assert.equal(clicks[1].started[0], 1.54)
    assert.notEqual(clicks[0].buffer, clicks[1].buffer)
    if (bars >= 2) assert.equal(clicks[0].buffer, clicks[4].buffer)
    assert.equal(clicks[0].outputs[0].outputs[0].outputs[0], nodes(stems[0]).master)
    assert.equal(nodes(stems[0]).master.gain.value, 0.6)
    assert.deepEqual(stems[0].started, [1.04 + bars * 2, 3])
    assert.equal(engine.phase(), 'counting')
    assert.equal(engine.expected(), 3)
    ctx.currentTime = 1.55
    assert.deepEqual(engine.countProgress(), { bar: 1, beat: 2 })
    ctx.currentTime = 1.04 + bars * 2
    assert.equal(engine.phase(), 'playing')
    assert.equal(engine.countProgress(), null)
    assert.equal(engine.expected(), 3)
    ctx.currentTime += 0.5
    assert.equal(engine.expected(), 3.5)
  }
})

test('cancelling count-in stops all scheduled sources and never starts after context resumes', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  await engine.start(2, { bars: 2, bpm: 120, beatsPerBar: 3 })
  const scheduled = [...Context.last.sources]
  engine.setPlaying(false, 2)
  assert.ok(scheduled.every((source) => source.stopped && source.outputs.length === 0))
  Context.last.currentTime = 100
  assert.equal(engine.phase(), 'paused')
  assert.equal(engine.expected(), 2)
  let resume
  Context.last.resume = () => new Promise((resolve) => { resume = resolve })
  const pending = engine.start(4, { bars: 1, bpm: 120, beatsPerBar: 4 })
  engine.stopAll()
  resume()
  assert.equal(await pending, false)
  assert.equal(Context.last.sources.length, scheduled.length)
  assert.equal(engine.phase(), 'paused')
})

test('invalid count-in values schedule no audio', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  for (const count of [
    { bars: 1, bpm: NaN, beatsPerBar: 4 },
    { bars: 1, bpm: 0, beatsPerBar: 4 },
    { bars: 5, bpm: 120, beatsPerBar: 4 },
    { bars: 1, bpm: 120, beatsPerBar: 0 }
  ]) await assert.rejects(() => engine.start(0, count))
  assert.equal(engine.phase(), 'paused')
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

test('metronome uses song beat timestamps after seeking and stops independently of stems', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.setMetronome([0.25, 0.75, 1.25, 3, 5.5, 9.75])
  await engine.start(0.4)
  const ctx = Context.last
  const clicks = ctx.sources.filter(source => source.buffer.duration < 0.1)
  assert.equal(clicks.length, 5)
  assert.ok(Math.abs(clicks[0].started[0] - 1.39) < 1e-9)
  assert.ok(Math.abs(clicks.at(-1).started[0] - 10.39) < 1e-9)
  const stems = ctx.sources.filter(source => source.buffer.duration === 10)
  engine.setMetronome(null)
  assert.ok(clicks.every(source => source.stopped))
  assert.ok(stems.every(source => !source.stopped))
  ctx.currentTime = 2
  engine.setMetronome([0.25, 0.75, 1.25, 3, 5.5, 9.75])
  const resumed = ctx.sources.filter(source => source.buffer.duration < 0.1 && !source.stopped)
  assert.equal(resumed.length, 3)
  engine.setPlaying(true, 5)
  assert.ok(resumed.every(source => source.stopped))
  const afterSeek = ctx.sources.filter(source => source.buffer.duration < 0.1 && !source.stopped)
  assert.equal(afterSeek.length, 2)
  assert.ok(Math.abs(afterSeek[0].started[0] - 2.54) < 1e-9)
  engine.stopAll()
  assert.ok(afterSeek.every(source => source.stopped))
})

test('click volume changes both count-in and metronome without changing song volume', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.applyMix({}, new Set(), new Set(), 0.8)
  engine.setClickVolume(0.3)
  engine.setMetronome([0, 0.5, 1])
  await engine.start(0, { bars: 1, bpm: 120, beatsPerBar: 4 })
  const ctx = Context.last
  const clicks = ctx.sources.filter(source => source.buffer.duration < 0.1)
  const stems = ctx.sources.filter(source => source.buffer.duration === 10)
  assert.deepEqual(clicks.map(source => source.started[0]), [1.04, 1.54, 2.04, 2.54, 3.04, 3.54, 4.04])
  const clickGain = clicks[0].outputs[0]
  assert.ok(clicks.every(source => source.outputs[0] === clickGain))
  assert.equal(clickGain.gain.value, 0.6)
  assert.equal(clickGain.outputs[0].outputs[0], nodes(stems[0]).master)
  engine.setClickVolume(0)
  assert.equal(clickGain.gain.value, 0)
  assert.equal(nodes(stems[0]).master.gain.value, 0.8)
  engine.setClickVolume(1)
  assert.equal(clickGain.gain.value, 2)
  engine.setBuffers(buffers)
  engine.setPlaying(true, 0)
  assert.equal(ctx.sources.filter(source => source.buffer.duration < 0.1 && !source.stopped).length, 0)
})


test('maximum click volume has extra headroom while each click stays below full scale', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.setClickVolume(1)
  engine.applyMix({}, new Set(), new Set(), 1)
  engine.setMetronome([0, 0.5])
  await engine.start(0, { bars: 1, bpm: 120, beatsPerBar: 4 })
  const clicks = Context.last.sources.filter(source => source.buffer.duration < 0.1)
  assert.equal(clicks[0].outputs[0].gain.value, 2)
  for (const source of clicks) {
    const samples = source.buffer.getChannelData(0)
    const peak = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0)
    assert.ok(peak * source.outputs[0].gain.value <= 1, 'Click alone exceeds full scale at maximum volume')
    assert.equal(samples[0], 0)
    assert.ok(Math.abs(samples.at(-1)) < 0.005, 'Click tail should decay to near silence')
  }
  engine.setClickVolume(-1)
  assert.equal(clicks[0].outputs[0].gain.value, 0)
  engine.setClickVolume(2)
  assert.equal(clicks[0].outputs[0].gain.value, 2)
  engine.setClickVolume(Number.NaN)
  assert.equal(clicks[0].outputs[0].gain.value, 1)
})


test('click keeps the original short tone and higher count-in accent', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  await engine.start(0, { bars: 1, bpm: 120, beatsPerBar: 4 })
  const clicks = Context.last.sources.filter(source => source.buffer.duration < 0.1)
  for (const [index, minimum, maximum] of [[0, 14, 15], [1, 9, 10]]) {
    const buffer = clicks[index].buffer
    assert.ok(Math.abs(buffer.duration - 0.035) < 0.0001)
    const samples = buffer.getChannelData(0)
    let crossings = 0
    for (let i = 1; i < 441; i++) {
      if (samples[i - 1] < 0 && samples[i] >= 0) crossings++
    }
    assert.ok(crossings >= minimum && crossings <= maximum, 'Click pitch changed from the original tone')
  }
})


test('metronome pan applies to live clicks and count-in independently of stem pan', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.applyMix({}, new Set(), new Set(), 0.8, { vocals: -0.25, metronome: -1 })
  engine.setMetronome([0.1, 0.6])
  await engine.start(0, { bars: 1, bpm: 120, beatsPerBar: 4 })
  const clicks = Context.last.sources.filter(source => source.buffer.duration < 0.1)
  const stems = Context.last.sources.filter(source => source.buffer.duration === 10)
  const clickGain = clicks[0].outputs[0]
  const clickPan = clickGain.outputs[0]
  assert.equal(clickPan.pan?.value, -1)
  assert.ok(clicks.every(source => source.outputs[0] === clickGain))
  assert.equal(nodes(stems[0]).pan.pan.value, -0.25)
  engine.applyMix({}, new Set(), new Set(), 0.8, { vocals: -0.25, metronome: 1 })
  assert.equal(clickPan.pan.value, 1)
  assert.equal(nodes(stems[0]).pan.pan.value, -0.25)
  engine.setPlaying(true, 3)
  assert.equal(clickPan.pan.value, 1)
  engine.setBuffers(buffers)
  assert.equal(clickPan.pan.value, 0)
})

test('practice rate preserves source position, scales beats, and resets without changing buffers', async () => {
  const processors = []
  const engine = new StemEngine(async () => ({
    latency: 0.1,
    create() {
      const node = new AudioNode()
      processors.push(node)
      return { node, dispose: () => node.disconnect() }
    }
  }))
  engine.setBuffers(buffers)
  engine.setMetronome([2, 3, 4, 5, 6, 7, 8])
  await engine.setRate(0.75)
  await engine.start(2)
  const ctx = Context.last
  const stems = ctx.sources.filter(s => s.buffer.duration === 10 && !s.stopped)
  assert.equal(stems.length, 2)
  assert.ok(stems.every(s => s.playbackRate.value === 0.75 && s.started[1] === 2))
  ctx.currentTime = 3
  const position = engine.expected()
  const changed = await engine.setRate(1.5)
  assert.equal(changed, true)
  assert.ok(Math.abs(engine.expected() - position) < 1e-9)
  const liveStems = ctx.sources.filter(s => s.buffer.duration === 10 && !s.stopped)
  assert.ok(liveStems.every(s => s.playbackRate.value === 1.5 && s.started[1] === position))
  const clicks = ctx.sources.filter(s => s.buffer.duration < .1 && !s.stopped)
  assert.ok(Math.abs(clicks[1].started[0] - clicks[0].started[0] - 1 / 1.5) < 1e-9)
  engine.setPlaying(false, position)
  await engine.setRate(1)
  assert.equal(engine.expected(), position)
  assert.equal(engine.phase(), 'paused')
  await engine.start(position)
  assert.ok(ctx.sources.filter(s => s.buffer.duration === 10 && !s.stopped).every(s => s.playbackRate.value === 1))
  assert.ok(processors.every(p => p.outputs.length === 0))
})

test('pause or song replacement cancels an outstanding practice rate change', async () => {
  let finish
  const engine = new StemEngine(() => new Promise(resolve => { finish = resolve }))
  engine.setBuffers(buffers)
  await engine.start(2)
  const pending = engine.setRate(0.5)
  engine.setPlaying(false, 2)
  finish({ latency: 0.1, create() { throw new Error('Stale processor created') } })
  assert.equal(await pending, false)
  assert.equal(engine.phase(), 'paused')
  assert.equal(engine.rate, 1)
  engine.setBuffers(buffers)
  assert.equal(engine.rate, 1)
})

test('seeking during rate setup applies the new rate at the latest source position', async () => {
  let finish
  const engine = new StemEngine(() => new Promise(resolve => { finish = resolve }))
  engine.setBuffers(buffers)
  await engine.start(0)
  const pending = engine.setRate(0.5)
  engine.setPlaying(true, 7)
  finish({ latency: 0.1, create: () => ({ node: new AudioNode(), dispose() {} }) })
  assert.equal(await pending, true)
  assert.equal(engine.rate, 0.5)
  assert.equal(engine.expected(), 7)
})

test('reset invalidates a pending slower rate even before it has been applied', async () => {
  let finish
  const engine = new StemEngine(() => new Promise(resolve => { finish = resolve }))
  engine.setBuffers(buffers)
  const pending = engine.setRate(0.5)
  await engine.setRate(1)
  finish({ latency: 0, create() { throw new Error('Stale processor created') } })
  assert.equal(await pending, false)
  assert.equal(engine.rate, 1)
})

test('derived count-in BPM supports slowed and faster song sections beyond the input range', async () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  for (const bpm of [3, 400, 3000]) {
    await engine.start(0, { bars: 1, bpm, beatsPerBar: 1 })
    assert.equal(engine.phase(), 'counting')
    engine.stopAll()
  }
})

test('full BPM input range supports a tenfold rate ratio', async () => {
  const engine = new StemEngine(async () => ({ latency: 0, create: () => ({ node: new AudioNode(), dispose() {} }) }))
  engine.setBuffers(buffers)
  assert.equal(await engine.setRate(10), true)
  assert.equal(engine.rate, 10)
  await assert.rejects(engine.setRate(10.01))
})

test('pausing during asynchronous pitch construction disposes the stale processor without starting audio', async () => {
  let finish
  let disposed = 0
  const engine = new StemEngine(async () => ({ latency: 0.1, create: () => new Promise(resolve => { finish = resolve }) }))
  engine.setBuffers(buffers)
  await engine.setRate(0.75)
  const pending = engine.start(2)
  await Promise.resolve()
  await engine.setPlaying(false, 2)
  finish({ node: new AudioNode(), dispose() { disposed++ } })
  assert.equal(await pending, false)
  assert.equal(disposed, 1)
  assert.equal(engine.phase(), 'paused')
  assert.equal(Context.last.sources.length, 0)
})

test('a later seek owns asynchronous pitch setup and discards the earlier processor', async () => {
  const pending = []
  let disposed = 0
  const engine = new StemEngine(async () => ({ latency: 0.1, create: () => new Promise(resolve => pending.push(resolve)) }))
  engine.setBuffers(buffers)
  await engine.setRate(0.75)
  const first = engine.start(2)
  await Promise.resolve()
  const second = engine.setPlaying(true, 7)
  pending[1]({ node: new AudioNode(), dispose() { disposed++ } })
  assert.equal(await second, true)
  pending[0]({ node: new AudioNode(), dispose() { disposed++ } })
  assert.equal(await first, false)
  assert.equal(disposed, 1)
  assert.equal(engine.expected(), 7)
  assert.ok(Context.last.sources.every(source => source.started[1] === 7))
  engine.stopAll()
})

test('failed asynchronous pitch construction leaves playback paused', async () => {
  const engine = new StemEngine(async () => ({ latency: 0.1, create: async () => { throw new Error('Processor failed') } }))
  engine.setBuffers(buffers)
  await engine.setRate(0.75)
  await assert.rejects(engine.start(2), /Processor failed/)
  assert.equal(engine.phase(), 'paused')
})
