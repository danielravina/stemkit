import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'

const hooks = registerTsHooks()
const { exportMixed, exportSeparate, exportOriginal, renderOffline } = await import('../src/renderer/src/lib/exporter.ts')
hooks.deregister()

// A minimal Web Audio stand-in: enough for renderOffline at 0 semitones and for
// decodeAudioData, recording the sample rate each decode ran at. suspend/resume
// follow Chromium: one suspend per render quantum, before the end, and the
// render only goes on after resume().
let log = []
let decoding = 0
let maxConcurrentDecodes = 0
let lastContext = null
const QUANTUM = 128

class Node {
  connect(n) { return n }
}
class FakeOfflineContext {
  constructor(channels, length, sampleRate) {
    this.length = length
    this.sampleRate = sampleRate
    this.destination = new Node()
    this.suspends = []
    this.resumes = 0
    this.rendering = false
    lastContext = this
  }
  suspend(t) {
    const frame = Math.floor((t * this.sampleRate) / QUANTUM) * QUANTUM
    if (this.rendering) return Promise.reject(new Error('suspend after start'))
    if (frame >= this.length) return Promise.reject(new Error('suspend past the end'))
    if (this.suspends.some((s) => s.frame === frame)) return Promise.reject(new Error('duplicate suspend'))
    return new Promise((res) => this.suspends.push({ frame, res }))
  }
  resume() {
    this.resumes++
    const go = this.waiting
    this.waiting = null
    go?.()
    return Promise.resolve()
  }
  async decodeAudioData(ab) {
    const tag = new TextDecoder().decode(new Uint8Array(ab))
    decoding++
    maxConcurrentDecodes = Math.max(maxConcurrentDecodes, decoding)
    log.push(`decode:${tag}@${this.sampleRate}`)
    await new Promise((r) => setTimeout(r, 1))
    decoding--
    // 0.1 s: long enough for the 5% suspend checkpoints to land on distinct quanta
    return { duration: 0.1, tag }
  }
  createBufferSource() { return Object.assign(new Node(), { start() {} }) }
  createGain() { return Object.assign(new Node(), { gain: { value: 1 } }) }
  createStereoPanner() { return Object.assign(new Node(), { pan: { value: 0 } }) }
  async startRendering() {
    this.rendering = true
    for (const s of [...this.suspends].sort((a, b) => a.frame - b.frame)) {
      const resumed = new Promise((r) => { this.waiting = r })
      s.res()
      await resumed
    }
    const data = [new Float32Array(this.length), new Float32Array(this.length)]
    return { getChannelData: (c) => data[c] }
  }
}
globalThis.OfflineAudioContext = FakeOfflineContext

const bytes = (s) => new TextEncoder().encode(s)
let mixPayload = bytes('mix')

beforeEach(() => {
  log = []
  maxConcurrentDecodes = 0
  mixPayload = bytes('mix')
  globalThis.window = {
    stemkit: {
      getBuffers: async (_id, stems) => {
        log.push(`getBuffers:${stems ? [...stems].sort().join(',') : 'all'}`)
        return { vocals: bytes('vocals'), drums: bytes('drums'), bass: bytes('bass'), other: bytes('other') }
      },
      getMix: async () => {
        log.push('getMix')
        return mixPayload
      },
      exportBegin: async (kind, name) => {
        log.push(`begin:${kind}:${name}`)
        return { token: 't', path: '/out' }
      },
      exportWrite: async (_t, name) => {
        log.push(`write:${name}`)
        return '/out/x.wav'
      },
      exportEnd: async () => { log.push('end') }
    }
  }
})

const base = {
  videoId: 'v',
  title: 'Song',
  stems: ['vocals', 'drums', 'bass', 'other'],
  vols: {},
  pans: {},
  semitones: 0
}

test('exportMixed decodes only the checked stems from the raw payload at 44.1 kHz', async () => {
  await exportMixed({ ...base, selected: ['bass', 'drums'] })
  const decodes = log.filter((l) => l.startsWith('decode:'))
  assert.deepEqual(decodes.sort(), ['decode:bass@44100', 'decode:drums@44100'])
  assert.deepEqual(log.filter((l) => l.startsWith('write:')), ['write:null'])
})

test('exportSeparate decodes one stem at a time, each written before the next decode', async () => {
  await exportSeparate({ ...base, selected: ['drums', 'bass'] })
  assert.equal(maxConcurrentDecodes, 1)
  const steps = log.filter((l) => l.startsWith('decode:') || l.startsWith('write:'))
  assert.deepEqual(steps, [
    'decode:drums@44100', 'write:drums',
    'decode:bass@44100', 'write:bass'
  ])
})

test('exportSeparate never adds the original mix to the folder', async () => {
  const result = await exportSeparate({ ...base, selected: ['drums', 'mix'] })
  assert.equal(log.includes('getMix'), false)
  assert.deepEqual(log.filter((l) => l.startsWith('write:')), ['write:drums'])
  assert.equal(result.count, 1)
})

test('exportOriginal writes the original mix as one file named after the song', async () => {
  const path = await exportOriginal({ ...base, selected: ['mix'] })
  assert.equal(path, '/out/x.wav')
  assert.ok(log.includes('begin:file:Song'), log.join(' '))
  assert.deepEqual(log.filter((l) => l.startsWith('decode:') || l.startsWith('write:')), [
    'decode:mix@44100', 'write:null'
  ])
  // the stems are never fetched for the original mix
  assert.equal(log.some((l) => l.startsWith('getBuffers')), false)
})

test('exportOriginal with a missing original mix fails before opening a session or writing', async () => {
  mixPayload = null
  await assert.rejects(exportOriginal({ ...base, selected: ['mix'] }), /no original mix/i)
  assert.equal(log.some((l) => l.startsWith('begin') || l.startsWith('write')), false)
})

test('exportOriginal checks the mix before the picker', async () => {
  await exportOriginal({ ...base, selected: ['mix'] })
  assert.ok(log.indexOf('getMix') < log.findIndex((l) => l.startsWith('begin')), log.join(' '))
})

test('exports only fetch the raw bytes of the checked stems', async () => {
  await exportMixed({ ...base, selected: ['bass', 'drums'] })
  assert.ok(log.includes('getBuffers:bass,drums'), log.join(' '))
  log = []
  await exportSeparate({ ...base, selected: ['other'] })
  assert.ok(log.includes('getBuffers:other'), log.join(' '))
})

const isMonotonic = (xs) => xs.every((x, i) => i === 0 || x >= xs[i - 1])

test('renderOffline reports render progress from suspend checkpoints, ending at 1', async () => {
  const fractions = []
  const buffer = { duration: 1 }
  await renderOffline([{ buffer, gain: 1, pan: 0 }], 0, undefined, (f) => fractions.push(f))
  // 19 checkpoints (5%..95%) plus the end
  assert.equal(lastContext.suspends.length, 19)
  assert.equal(lastContext.resumes, 19)
  assert.ok(lastContext.suspends.every((s) => s.frame % QUANTUM === 0 && s.frame > 0))
  assert.equal(fractions.length, 20)
  assert.ok(isMonotonic(fractions), fractions.join(' '))
  assert.ok(fractions[0] > 0.04 && fractions[0] <= 0.05, String(fractions[0]))
  assert.equal(fractions.at(-1), 1)
})

test('renderOffline skips checkpoints that would share a render quantum', async () => {
  const fractions = []
  // 300 frames: 5% steps of 15 frames collapse onto quanta 128 and 256, and
  // 256 is dropped because its quantum runs past the end
  await renderOffline([{ buffer: { duration: 300 / 44100 }, gain: 1, pan: 0 }], 0, undefined, (f) => fractions.push(f))
  assert.deepEqual(lastContext.suspends.map((s) => s.frame), [128])
  assert.ok(isMonotonic(fractions))
  assert.equal(fractions.at(-1), 1)
})

test('renderOffline still finishes when the progress callback throws', async () => {
  const out = await renderOffline([{ buffer: { duration: 0.1 }, gain: 1, pan: 0 }], 0, undefined, (f) => {
    if (f < 1) throw new Error('boom')
  })
  assert.equal(out[0].length, 4410)
  assert.equal(lastContext.resumes, lastContext.suspends.length)
})

test('renderOffline without a progress callback schedules no suspends', async () => {
  await renderOffline([{ buffer: { duration: 1 }, gain: 1, pan: 0 }], 0)
  assert.equal(lastContext.suspends.length, 0)
})

test('exportMixed reports one step whose fraction climbs to 1', async () => {
  const events = []
  await exportMixed({ ...base, selected: ['bass', 'drums'] }, (p) => events.push(p))
  assert.ok(events.length > 5, String(events.length))
  assert.ok(events.every((p) => p.step === 1 && p.steps === 1))
  assert.ok(isMonotonic(events.map((p) => p.fraction)))
  assert.equal(events.at(-1).fraction, 1)
  const labels = new Set(events.map((p) => p.label))
  assert.ok(labels.has('Rendering mix') && labels.has('Saving mix'), [...labels].join(','))
  // rendering spans 10%..90% of the file
  const rendering = events.filter((p) => p.label === 'Rendering mix').map((p) => p.fraction)
  assert.ok(Math.max(...rendering) <= 0.9 + 1e-9 && rendering.some((f) => f > 0.5))
})

test('exportSeparate reports one step per stem, split evenly across the total', async () => {
  const events = []
  await exportSeparate({ ...base, selected: ['drums', 'bass'] }, (p) => events.push(p))
  assert.ok(events.every((p) => p.steps === 2))
  assert.ok(isMonotonic(events.map((p) => p.fraction)))
  assert.ok(isMonotonic(events.map((p) => p.step)))
  assert.equal(events.at(-1).fraction, 1)
  const firstBass = events.find((p) => p.label === 'Rendering bass')
  assert.equal(firstBass.step, 2)
  assert.ok(firstBass.fraction >= 0.5, String(firstBass.fraction))
  const order = [...new Set(events.map((p) => p.label))].filter((l) => l !== 'Preparing')
  assert.deepEqual(order, ['Rendering drums', 'Saving drums', 'Rendering bass', 'Saving bass'])
})

test('exportOriginal reports the original mix as one step', async () => {
  const events = []
  await exportOriginal({ ...base, selected: ['mix'] }, (p) => events.push(p))
  assert.ok(events.every((p) => p.step === 1 && p.steps === 1))
  assert.ok(events.some((p) => p.label === 'Rendering original mix'))
  assert.ok(isMonotonic(events.map((p) => p.fraction)))
  assert.equal(events.at(-1).fraction, 1)
})

test('a cancelled picker reports no progress', async () => {
  window.stemkit.exportBegin = async () => null
  const events = []
  assert.equal(await exportMixed({ ...base, selected: ['drums'] }, (p) => events.push(p)), null)
  assert.equal(events.length, 0)
})
