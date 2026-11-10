// Same layout as save_wav_f32 in python/separate.py: 32-bit float PCM
// (format tag 3), little-endian, interleaved.
export function encodeWavF32(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nch = channels.length
  const frames = nch ? channels[0].length : 0
  const dataBytes = frames * nch * 4
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const tag = (off: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[off + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true)
  view.setUint16(22, nch, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * nch * 4, true)
  view.setUint16(32, nch * 4, true)
  view.setUint16(34, 32, true)
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  let off = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      view.setFloat32(off, channels[c][i], true)
      off += 4
    }
  }
  return out
}
