declare module 'signalsmith-stretch' {
  export interface StretchNode extends AudioWorkletNode {
    latency(): Promise<number>
    schedule(options: { active?: boolean; output?: number; semitones?: number }): Promise<unknown>
    stop(when?: number): Promise<unknown>
  }
  interface StretchFactory {
    (context: BaseAudioContext): Promise<StretchNode>
    moduleUrl?: string
  }
  const createStretch: StretchFactory
  export default createStretch
}
