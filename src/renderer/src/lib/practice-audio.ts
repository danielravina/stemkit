import createStretch, { type StretchNode } from 'signalsmith-stretch'
import processorUrl from './signalsmith-processor.ts?worker&url'
import type { PitchSetup } from './engine'

// Serve the official worklet as a build asset rather than generating a blob URL.
createStretch.moduleUrl = processorUrl
const latencies = new WeakMap<AudioContext, Promise<number>>()

function disposeNode(node: StretchNode): void {
  node.disconnect()
  void node.stop().finally(() => node.port.close()).catch(() => {})
}

async function latencyFor(context: AudioContext): Promise<number> {
  let pending = latencies.get(context)
  if (!pending) {
    pending = (async () => {
      const node = await createStretch(context)
      try {
        return await node.latency()
      } finally {
        disposeNode(node)
      }
    })()
    latencies.set(context, pending)
    void pending.catch(() => latencies.delete(context))
  }
  return pending
}

export async function preparePitch(context: AudioContext, rate: number): Promise<PitchSetup> {
  const latency = await latencyFor(context)
  return {
    latency,
    async create() {
      const node = await createStretch(context)
      try {
        // Native sources supply the tempo change; live-input processing restores
        // their original pitch. Signalsmith's rate option applies only to buffers.
        await node.schedule({ active: true, output: 0, semitones: -12 * Math.log2(rate) })
        const silence = context.createConstantSource()
        silence.offset.value = 0
        silence.connect(node)
        silence.start()
        return { node, dispose: () => { silence.stop(); silence.disconnect(); disposeNode(node) } }
      } catch (error) {
        disposeNode(node)
        throw error
      }
    }
  }
}
