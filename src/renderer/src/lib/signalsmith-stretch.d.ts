// Minimal types for only what pitch.ts uses
declare module 'signalsmith-stretch' {
  export interface StretchNode extends AudioNode {
    schedule(change: { active?: boolean; semitones?: number; formantCompensation?: boolean }): void
    latency(): Promise<number>
  }
  export default function SignalsmithStretch(ctx: BaseAudioContext): Promise<StretchNode>
}
