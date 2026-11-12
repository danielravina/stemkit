// Pure helpers for offline export rendering. No DOM types, so node:test can import it.

export function renderLength(durations: number[], sampleRate: number): number {
  return Math.ceil(Math.max(...durations) * sampleRate)
}

// Drops the shifter's start-up latency and pads with silence if the render ran short.
export function trimLatency(
  channels: Float32Array[],
  latencySamples: number,
  length: number
): Float32Array[] {
  return channels.map((ch) => {
    const out = new Float32Array(length)
    out.set(ch.subarray(latencySamples, latencySamples + length))
    return out
  })
}

// Scales in place only when the mix would clip; returns the gain applied.
export function limitPeak(channels: Float32Array[], ceiling = 0.98855): number {
  let peak = 0
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]))
  if (peak <= 1) return 1
  const gain = ceiling / peak
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain
  return gain
}
