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
  const creating = SignalsmithStretch(ctx)
  let node: Awaited<typeof creating>
  let latency: number
  try {
    ;[node, latency] = await Promise.race([
      creating.then(async (n) => [n, await n.latency()] as const),
      timeout
    ])
  } catch (err) {
    // a load that finishes after the timeout would leave an orphan worklet
    // running; retries make that repeatable, so shut it down when it lands
    void creating.then((n) => {
      n.schedule({ active: false })
      n.disconnect()
    }, () => {})
    throw err
  } finally {
    clearTimeout(timer)
  }
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
