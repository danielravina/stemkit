export const CLICK_SAMPLE_RATE = 44100
export const CLICK_GAIN = 2

export function clickSamples(accent = false): Float32Array {
  const samples = new Float32Array(Math.round(CLICK_SAMPLE_RATE * 0.035))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(2 * Math.PI * (accent ? 1500 : 1000) * i / CLICK_SAMPLE_RATE) * Math.exp(-i / (CLICK_SAMPLE_RATE * 0.006)) * (accent ? 0.5 : 0.45)
  }
  return samples
}

export function manualBeats(bpm: number, duration: number): number[] {
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300 || !Number.isFinite(duration) || duration <= 0) return []
  return Array.from({ length: Math.ceil(duration * bpm / 60) }, (_, index) => index * 60 / bpm)
}


export function metronomePeaks(beats: number[], duration: number, buckets = 1600): Float32Array {
  const peaks = new Float32Array(buckets)
  if (!Number.isFinite(duration) || duration <= 0) return peaks
  const frames = Math.ceil(duration * CLICK_SAMPLE_RATE)
  const click = clickSamples()
  for (const beat of beats) {
    if (!Number.isFinite(beat) || beat < 0 || beat >= duration) continue
    const first = Math.round(beat * CLICK_SAMPLE_RATE)
    for (let i = 0; i < click.length && first + i < frames; i += 4) {
      const bucket = Math.floor((first + i) / frames * buckets)
      peaks[bucket] = Math.max(peaks[bucket], Math.abs(click[i]))
    }
  }
  const maximum = peaks.reduce((max, value) => Math.max(max, value), 0.0001)
  return peaks.map(value => value / maximum)
}
