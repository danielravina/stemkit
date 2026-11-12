import type { StemId, StemPanMap } from '../../../shared/types'
import { encodeWavF32 } from '../../../shared/wav'
import { MIX_ID, mixedBaseName, originalMixName, separateFolderName } from '../../../shared/export-rules'
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

// startRendering gives no progress of its own; suspending at fixed points and
// resuming right away does, without touching the rendered samples
const CHECKPOINTS = 20
const RENDER_QUANTUM = 128

function scheduleCheckpoints(ctx: OfflineAudioContext, onRender: (fraction: number) => void): void {
  let last = 0
  for (let k = 1; k < CHECKPOINTS; k++) {
    // Chromium rounds suspend times to a render quantum and rejects two in the
    // same quantum (or one at the end), so short renders get fewer checkpoints
    const frame = Math.floor((ctx.length * k) / CHECKPOINTS / RENDER_QUANTUM) * RENDER_QUANTUM
    if (frame <= last || frame + RENDER_QUANTUM > ctx.length) continue
    last = frame
    // aim mid-quantum: frame / sampleRate can round just below the boundary
    // and land in the previous quantum, which may already be taken
    const at = (frame + RENDER_QUANTUM / 2) / ctx.sampleRate
    ctx.suspend(at).then(
      () => {
        // progress is cosmetic: a failing callback must neither stall the
        // render (no resume) nor surface as an unhandled rejection
        try {
          onRender(frame / ctx.length)
        } catch {
          // ignored on purpose
        }
        ctx.resume().catch(() => {})
      },
      // a rejected checkpoint only means one progress tick fewer
      () => {}
    )
  }
}

// Renders the sources through the same per-stem gain → pan chain as the live
// engine, without the master volume, at 44.1 kHz stereo. The output has the
// length of the longest source: the shifter delay is trimmed off the front.
export async function renderOffline(
  sources: RenderSource[],
  semitones: number,
  factory: ShifterFactory = createPitchShifter,
  onRender?: (fraction: number) => void
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
    // every suspend has to be scheduled before rendering starts
    if (onRender) scheduleCheckpoints(ctx, onRender)
    const rendered = await ctx.startRendering()
    onRender?.(1)
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

// stems in display order; the original mix has its own export
function chosenStems(opts: ExportOptions): string[] {
  return opts.stems.filter((id) => id !== MIX_ID && opts.selected.includes(id))
}

export interface ExportProgress {
  // what is happening now, e.g. "Rendering drums"
  label: string
  // 1-based file index and file count
  step: number
  steps: number
  // overall progress across every file, 0..1
  fraction: number
}

export type OnProgress = (p: ExportProgress) => void

// Each file weighs the same: decoding 10%, rendering 80%, writing 10%. Decoding
// is fast but the render is what the user waits for.
const DECODE = 0.1
const RENDER = 0.8

function progress(steps: number, onProgress?: OnProgress) {
  return (step: number, label: string, within: number): void => {
    onProgress?.({ label, step, steps, fraction: Math.min(1, (step - 1 + within) / steps) })
  }
}

// one output file from sources decoded one by one, reporting as it goes
async function renderFile(
  step: number,
  name: string,
  report: ReturnType<typeof progress>,
  decode: Array<() => Promise<RenderSource>>,
  semitones: number
): Promise<Uint8Array> {
  const rendering = `Rendering ${name}`
  const sources: RenderSource[] = []
  for (const next of decode) {
    sources.push(await next())
    report(step, rendering, (DECODE * sources.length) / decode.length)
  }
  const channels = await renderOffline(sources, semitones, undefined, (f) =>
    report(step, rendering, DECODE + RENDER * f)
  )
  report(step, `Saving ${name}`, DECODE + RENDER)
  return encodeWavF32(channels, SAMPLE_RATE)
}

export async function exportMixed(
  opts: ExportOptions,
  onProgress?: OnProgress
): Promise<string | null> {
  const ids = chosenStems(opts)
  if (ids.length === 0) throw new Error('Select at least one stem')
  const session = await window.stemkit.exportBegin(
    'file',
    mixedBaseName(opts.title, ids, opts.stems, opts.semitones)
  )
  if (!session) return null
  const report = progress(1, onProgress)
  try {
    report(1, 'Preparing', 0)
    const payload = await window.stemkit.getBuffers(opts.videoId, ids)
    const wav = await renderFile(
      1,
      'mix',
      report,
      ids.map((id) => () => stemSource(opts, payload, id)),
      opts.semitones
    )
    const path = await window.stemkit.exportWrite(session.token, null, wav)
    report(1, 'Saving mix', 1)
    return path
  } finally {
    await window.stemkit.exportEnd(session.token)
  }
}

// The original song as one file: pitch only, at full volume, ignoring the mixer.
export async function exportOriginal(
  opts: ExportOptions,
  onProgress?: OnProgress
): Promise<string | null> {
  // checked before the picker, so a song without a mix never opens a save dialog
  const mix = await window.stemkit.getMix(opts.videoId)
  if (!mix) throw new Error('This song has no original mix to export')
  const session = await window.stemkit.exportBegin(
    'file',
    originalMixName(opts.title, opts.semitones)
  )
  if (!session) return null
  const report = progress(1, onProgress)
  try {
    report(1, 'Preparing', 0)
    const wav = await renderFile(
      1,
      'original mix',
      report,
      [async () => ({ buffer: await decodeAtExportRate(mix), gain: 1, pan: 0 })],
      opts.semitones
    )
    const path = await window.stemkit.exportWrite(session.token, null, wav)
    report(1, 'Saving original mix', 1)
    return path
  } finally {
    await window.stemkit.exportEnd(session.token)
  }
}

export async function exportSeparate(
  opts: ExportOptions,
  onProgress?: OnProgress
): Promise<{ path: string; count: number } | null> {
  const ids = chosenStems(opts)
  if (ids.length === 0) throw new Error('Select at least one stem')
  const session = await window.stemkit.exportBegin(
    'folder',
    separateFolderName(opts.title, opts.semitones)
  )
  if (!session) return null
  const report = progress(ids.length, onProgress)
  let count = 0
  try {
    report(1, 'Preparing', 0)
    const payload = await window.stemkit.getBuffers(opts.videoId, ids)
    // one at a time: every decode and render holds a full-length stereo copy in memory
    for (const [i, id] of ids.entries()) {
      const wav = await renderFile(i + 1, id, report, [() => stemSource(opts, payload, id)], opts.semitones)
      await window.stemkit.exportWrite(session.token, id, wav)
      count++
      report(i + 1, `Saving ${id}`, 1)
    }
  } finally {
    await window.stemkit.exportEnd(session.token)
  }
  return { path: session.path, count }
}
