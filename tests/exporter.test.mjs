import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'

const hooks = registerTsHooks()
const { exportMixed, exportSeparate } = await import('../src/renderer/src/lib/exporter.ts')
hooks.deregister()

// A minimal Web Audio stand-in: enough for renderOffline at 0 semitones and for
// decodeAudioData, recording the sample rate each decode ran at.
let log = []
let decoding = 0
let maxConcurrentDecodes = 0

class Node {
  connect(n) { return n }
}
class FakeOfflineContext {
  constructor(channels, length, sampleRate) {
    this.length = length
    this.sampleRate = sampleRate
    this.destination = new Node()
  }
  async decodeAudioData(ab) {
    const tag = new TextDecoder().decode(new Uint8Array(ab))
    decoding++
    maxConcurrentDecodes = Math.max(maxConcurrentDecodes, decoding)
    log.push(`decode:${tag}@${this.sampleRate}`)
    await new Promise((r) => setTimeout(r, 1))
    decoding--
    return { duration: 0.001, tag }
  }
  createBufferSource() { return Object.assign(new Node(), { start() {} }) }
  createGain() { return Object.assign(new Node(), { gain: { value: 1 } }) }
  createStereoPanner() { return Object.assign(new Node(), { pan: { value: 0 } }) }
  async startRendering() {
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
      getBuffers: async () => {
        log.push('getBuffers')
        return { vocals: bytes('vocals'), drums: bytes('drums'), bass: bytes('bass'), other: bytes('other') }
      },
      getMix: async () => {
        log.push('getMix')
        return mixPayload
      },
      exportBegin: async (kind) => {
        log.push(`begin:${kind}`)
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
  await exportSeparate({ ...base, selected: ['drums', 'bass', 'mix'], includeMix: true })
  assert.equal(maxConcurrentDecodes, 1)
  const steps = log.filter((l) => l.startsWith('decode:') || l.startsWith('write:'))
  assert.deepEqual(steps, [
    'decode:drums@44100', 'write:drums',
    'decode:bass@44100', 'write:bass',
    'decode:mix@44100', 'write:Song'
  ])
})

test('exportSeparate with a missing original mix fails before opening a session or writing', async () => {
  mixPayload = null
  await assert.rejects(
    exportSeparate({ ...base, selected: ['drums', 'mix'], includeMix: true }),
    /no original mix/i
  )
  assert.equal(log.some((l) => l.startsWith('begin') || l.startsWith('write')), false)
})
