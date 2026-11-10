import type { StemId, StemPanMap } from '../../../shared/types'
import { encodeWavF32 } from '../../../shared/wav'
import { MIX_ID, mixedBaseName, separateFolderName } from '../../../shared/export-rules'
import { limitPeak, renderLength, trimLatency } from './render-math'
import { createPitchShifter } from './pitch'
import type { PitchShifter, ShifterFactory } from './pitch'

const SAMPLE_RATE = 44100

export interface RenderSource {
  buffer: AudioBuffer
  gain: number
  pan: number
}

// The shifter needs a context before its latency is known, so a shifted render
// gets a fixed pad longer than any latency signalsmith reports (~0.12 s)
const SHIFT_PAD = SAMPLE_RATE

// Renders the sources through the same per-stem gain → pan chain as the live
// engine, without the master volume, at 44.1 kHz stereo. The output has the
// length of the longest source: the shifter delay is trimmed off the front.
export async function renderOffline(
  sources: RenderSource[],
  semitones: number,
  factory: ShifterFactory = createPitchShifter
): Promise<Float32Array[]> {
  if (sources.length === 0) throw new Error('Nothing to export')
  const length = renderLength(
    sources.map((s) => s.buffer.duration),
    SAMPLE_RATE
  )
  const ctx = new OfflineAudioContext(2, length + (semitones !== 0 ? SHIFT_PAD : 0), SAMPLE_RATE)
  let shifter: PitchShifter | null = null
  let latencySamples = 0
  try {
    let target: AudioNode = ctx.destination
    if (semitones !== 0) {
      shifter = await factory(ctx)
      if (shifter.latency >= SHIFT_PAD / SAMPLE_RATE) {
        throw new Error(`Pitch shifter latency too large (${shifter.latency} s)`)
      }
      latencySamples = Math.ceil(shifter.latency * SAMPLE_RATE)
      shifter.setSemitones(semitones)
      shifter.output.connect(ctx.destination)
      target = shifter.input
    }
    for (const s of sources) {
      const src = ctx.createBufferSource()
      src.buffer = s.buffer
      const gain = ctx.createGain()
      gain.gain.value = s.gain
      const pan = ctx.createStereoPanner()
      pan.pan.value = s.pan
      src.connect(gain).connect(pan).connect(target)
      src.start(0)
    }
    const rendered = await ctx.startRendering()
    const out = trimLatency(
      [rendered.getChannelData(0), rendered.getChannelData(1)],
      latencySamples,
      length
    )
    limitPeak(out)
    return out
  } finally {
    // a fresh worklet per render: keeping it would hold the WASM instance alive
    shifter?.dispose()
  }
}

export interface ExportOptions {
  videoId: string
  title: string
  // every stem id of the song, in display order (never MIX_ID)
  stems: string[]
  selected: string[]
  vols: Partial<Record<StemId, number>>
  pans: StemPanMap
  // 0 exports at the original pitch
  semitones: number
}

// The player's buffers come from an AudioContext at the device rate (often
// 48 kHz), so rendering those at 44.1 kHz would resample twice. Stems are
// stored at 44.1 kHz: decoding the raw file at that rate keeps every sample.
function decodeAtExportRate(bytes: Uint8Array): Promise<AudioBuffer> {
  // decodeAudioData detaches the bytes, which are a throwaway IPC copy
  return new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(bytes.buffer as ArrayBuffer)
}

async function stemSource(
  opts: ExportOptions,
  payload: Record<string, Uint8Array>,
  id: string
): Promise<RenderSource> {
  const bytes = payload[id]
  if (!bytes) throw new Error(`Missing audio for ${id}`)
  // drop the reference so the bytes can go once decoded
  delete payload[id]
  return {
    buffer: await decodeAtExportRate(bytes),
    gain: opts.vols[id as StemId] ?? 1,
    pan: opts.pans[id as StemId] ?? 0
  }
}

// stems in display order; the original mix is handled separately (or ignored)
function chosenStems(opts: ExportOptions): string[] {
  return opts.stems.filter((id) => id !== MIX_ID && opts.selected.includes(id))
}

export async function exportMixed(opts: ExportOptions): Promise<string | null> {
  const ids = chosenStems(opts)
  if (ids.length === 0) throw new Error('Select at least one stem')
  const session = await window.stemkit.exportBegin(
    'file',
    mixedBaseName(opts.title, ids, opts.stems, opts.semitones)
  )
  if (!session) return null
  try {
    const payload = await window.stemkit.getBuffers(opts.videoId, ids)
    const sources: RenderSource[] = []
    for (const id of ids) sources.push(await stemSource(opts, payload, id))
    const channels = await renderOffline(sources, opts.semitones)
    return await window.stemkit.exportWrite(session.token, null, encodeWavF32(channels, SAMPLE_RATE))
  } finally {
    await window.stemkit.exportEnd(session.token)
  }
}

export async function exportSeparate(
  opts: ExportOptions & { includeMix: boolean }
): Promise<{ path: string; count: number } | null> {
  const ids = chosenStems(opts)
  if (ids.length === 0 && !opts.includeMix) throw new Error('Select at least one stem')
  // checked before the picker: a missing mix found after the stems would
  // leave a half-finished folder behind
  const mix = opts.includeMix ? await window.stemkit.getMix(opts.videoId) : null
  if (opts.includeMix && !mix) throw new Error('This song has no original mix to export')
  const session = await window.stemkit.exportBegin(
    'folder',
    separateFolderName(opts.title, opts.semitones)
  )
  if (!session) return null
  let count = 0
  try {
    const payload = ids.length > 0 ? await window.stemkit.getBuffers(opts.videoId, ids) : {}
    // one at a time: every decode and render holds a full-length stereo copy in memory
    for (const id of ids) {
      const channels = await renderOffline([await stemSource(opts, payload, id)], opts.semitones)
      await window.stemkit.exportWrite(session.token, id, encodeWavF32(channels, SAMPLE_RATE))
      count++
    }
    if (mix) {
      // the original mix ignores the mixer: pitch only, at full volume
      const buffer = await decodeAtExportRate(mix)
      const channels = await renderOffline([{ buffer, gain: 1, pan: 0 }], opts.semitones)
      await window.stemkit.exportWrite(session.token, opts.title, encodeWavF32(channels, SAMPLE_RATE))
      count++
    }
  } finally {
    await window.stemkit.exportEnd(session.token)
  }
  return { path: session.path, count }
}
