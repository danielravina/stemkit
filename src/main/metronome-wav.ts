import { clickSamples, CLICK_GAIN, CLICK_SAMPLE_RATE } from '../shared/metronome.ts'

export function renderMetronomeWav(beats: number[], duration: number): Buffer {
  const frames = Math.ceil(duration * CLICK_SAMPLE_RATE)
  if (!Number.isFinite(duration) || duration <= 0 || frames * 2 + 44 > 0xffffffff || !beats.length) {
    throw new Error('Invalid metronome duration or missing beats')
  }
  let previous = -1
  for (const beat of beats) {
    if (!Number.isFinite(beat) || beat < 0 || beat <= previous) throw new Error('Invalid metronome beats')
    previous = beat
  }
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(CLICK_SAMPLE_RATE, 24)
  wav.writeUInt32LE(CLICK_SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(frames * 2, 40)
  const click = clickSamples()
  for (const beat of beats) {
    const first = Math.round(beat * CLICK_SAMPLE_RATE)
    if (first >= frames) break
    for (let i = 0; i < click.length && first + i < frames; i++) {
      const offset = 44 + (first + i) * 2
      const value = wav.readInt16LE(offset) + Math.round(click[i] * CLICK_GAIN * 32767)
      wav.writeInt16LE(Math.max(-32768, Math.min(32767, value)), offset)
    }
  }
  return wav
}
