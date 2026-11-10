import SignalsmithStretch from 'signalsmith-stretch'
import { clampPitch } from '../../../shared/pitch-range'

export { PITCH_MIN, PITCH_MAX, clampPitch } from '../../../shared/pitch-range'

export interface PitchShifter {
  input: AudioNode
  output: AudioNode
  /** Seconds the shifter delays the signal. */
  latency: number
  setSemitones(n: number): void
  dispose(): void
}

export type ShifterFactory = (ctx: BaseAudioContext) => Promise<PitchShifter>

const LOAD_TIMEOUT_MS = 5000

export const createPitchShifter: ShifterFactory = async (ctx) => {
  // If WASM is blocked (e.g. CSP) the factory never settles, so bound the wait
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Pitch shifter failed to load')), LOAD_TIMEOUT_MS)
  })
  let node: Awaited<ReturnType<typeof SignalsmithStretch>>
  try {
    node = await Promise.race([SignalsmithStretch(ctx), timeout])
  } finally {
    clearTimeout(timer)
  }
  const latency = await node.latency()
  // Without active: true the node outputs silence
  const apply = (n: number): void =>
    node.schedule({ active: true, semitones: clampPitch(n), formantCompensation: true })
  return {
    input: node,
    output: node,
    latency,
    setSemitones: apply,
    dispose() {
      node.schedule({ active: false })
      node.disconnect()
    }
  }
}
