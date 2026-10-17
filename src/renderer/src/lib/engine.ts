import type { StemId, StemPanMap, MixChannelId } from '../../../shared/types'
import { clickSamples, CLICK_GAIN, CLICK_SAMPLE_RATE } from '../../../shared/metronome.ts'

export type BufferMap = Partial<Record<StemId, AudioBuffer>>
export interface PitchNode { node: AudioNode; dispose(): void }
export interface PitchSetup {
  latency: number
  create(): PitchNode | Promise<PitchNode>
}

export interface CountIn { bars: 1 | 2 | 3 | 4; bpm: number; beatsPerBar: number }

export async function decodePayload(
  payload: Record<string, Uint8Array>
): Promise<BufferMap> {
  const ctx = new AudioContext()
  void ctx.resume()
  const ids = Object.keys(payload)
  // decodeAudioData detaches the source buffer — the IPC payload is throwaway,
  // so hand it over as-is (skips a full copy per stem)
  const decoded = await Promise.all(
    ids.map((id) => ctx.decodeAudioData(payload[id].buffer as ArrayBuffer))
  )
  const out: BufferMap = {}
  ids.forEach((id, i) => {
    out[id as StemId] = decoded[i]
  })
  return out
}

export class StemEngine {
  private ctx: AudioContext | null = null
  private buffers: BufferMap = {}
  private gains: Partial<Record<StemId, GainNode>> = {}
  private panners: Partial<Record<StemId, StereoPannerNode>> = {}
  private mix = {
    vols: {} as Partial<Record<StemId, number>>,
    pans: {} as StemPanMap,
    mutes: new Set<MixChannelId>(),
    solos: new Set<MixChannelId>(),
    master: 0.9
  }
  private master: GainNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private playing = false
  private anchorYt = 0
  private anchorCtx = 0
  private request = 0
  private rateRequest = 0
  private alignRequest = 0
  private aligning = false
  private count: { start: number; interval: number; beatsPerBar: number } | null = null
  private clickBuffers: AudioBuffer[] = []
  private clickGain: GainNode | null = null
  private clickPanner: StereoPannerNode | null = null
  private clickVolume = 0.5
  private metronomeBeats: number[] = []
  private metronomeSources: AudioBufferSourceNode[] = []
  private pitchSetup: PitchSetup | null = null
  private pitch: PitchNode | null = null
  private playbackRate = 1

  private preparePitch: (context: AudioContext, rate: number) => Promise<PitchSetup>

  constructor(preparePitch: (context: AudioContext, rate: number) => Promise<PitchSetup> =
    async (context, rate) => (await import('./practice-audio')).preparePitch(context, rate)) {
    this.preparePitch = preparePitch
  }

  get rate(): number { return this.playbackRate }

  async setRate(rate: number): Promise<boolean> {
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 10) throw new Error('Practice speed must be between 0.1× and 10×.')
    const request = ++this.rateRequest
    if (rate === this.rate) return true
    const setup = rate === 1 ? null : await this.preparePitch(this.ensureCtx(), rate)
    if (request !== this.rateRequest) return false
    const position = this.expected()
    this.playbackRate = rate
    this.pitchSetup = setup
    return await this.align(position)
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.mix.master
      this.master.connect(this.ctx.destination)
      this.clickGain = this.ctx.createGain()
      this.clickGain.gain.value = this.clickVolume * CLICK_GAIN
      this.clickPanner = this.ctx.createStereoPanner()
      this.clickPanner.pan.value = this.mix.pans.metronome ?? 0
      this.clickGain.connect(this.clickPanner)
      this.clickPanner.connect(this.master)
    }
    return this.ctx
  }

  private getGain(id: StemId): GainNode {
    const ctx = this.ensureCtx()
    let g = this.gains[id]
    if (!g) {
      g = ctx.createGain()
      const pan = ctx.createStereoPanner()
      pan.pan.value = this.mix.pans[id] ?? 0
      g.gain.value = this.stemVolume(id)
      g.connect(pan)
      pan.connect(this.pitch?.node ?? this.master!)
      this.panners[id] = pan
      this.gains[id] = g
    }
    return g
  }

  resume(): void {
    void this.ensureCtx().resume()
  }

  async decode(payload: Record<string, Uint8Array>): Promise<void> {
    const buffers = await decodePayload(payload)
    this.buffers = buffers
  }

  setBuffers(buffers: BufferMap): void {
    this.stopAll()
    this.metronomeBeats = []
    this.playbackRate = 1
    this.pitchSetup = null
    if (this.ctx) this.clickPanner?.pan.setTargetAtTime(0, this.ctx.currentTime, 0.012)
    for (const gain of Object.values(this.gains)) gain?.disconnect()
    for (const pan of Object.values(this.panners)) pan?.disconnect()
    this.gains = {}
    this.panners = {}
    this.mix = { vols: {}, pans: {}, mutes: new Set(), solos: new Set(), master: 0.9 }
    this.buffers = buffers
  }

  private stemVolume(id: StemId): number {
    const { vols, mutes, solos } = this.mix
    return !mutes.has(id) && (solos.size === 0 || solos.has(id)) ? vols[id] ?? 1 : 0
  }

  hasBuffers(): boolean {
    return Object.keys(this.buffers).length > 0
  }

  setPlaying(playing: boolean, time: number): Promise<boolean> {
    ++this.request
    if (playing) this.resume()
    else ++this.rateRequest
    this.playing = playing
    return this.align(time)
  }

  async start(time: number, count?: CountIn): Promise<boolean> {
    if (count && (![1, 2, 3, 4].includes(count.bars) || !Number.isFinite(count.bpm) || count.bpm < 3 || count.bpm > 3000 ||
        !Number.isInteger(count.beatsPerBar) || count.beatsPerBar < 1 || count.beatsPerBar > 12)) {
      throw new Error('Invalid count-in')
    }
    const request = ++this.request
    const ctx = this.ensureCtx()
    await ctx.resume()
    if (request !== this.request) return false
    this.playing = true
    const aligned = await this.align(time, count)
    return aligned && request === this.request
  }

  phase(): 'paused' | 'counting' | 'playing' {
    if (!this.playing) return 'paused'
    return this.count && this.ctx!.currentTime < this.anchorCtx ? 'counting' : 'playing'
  }

  countProgress(): { bar: number; beat: number } | null {
    if (this.phase() !== 'counting' || !this.count) return null
    const index = Math.max(0, Math.floor((this.ctx!.currentTime - this.count.start) / this.count.interval))
    return { bar: Math.floor(index / this.count.beatsPerBar) + 1, beat: index % this.count.beatsPerBar + 1 }
  }

  private clickBuffer(accent: boolean): AudioBuffer {
    const index = accent ? 1 : 0
    if (!this.clickBuffers[index]) {
      const samples = clickSamples(accent)
      const buffer = this.ctx!.createBuffer(1, samples.length, CLICK_SAMPLE_RATE)
      buffer.getChannelData(0).set(samples)
      this.clickBuffers[index] = buffer
    }
    return this.clickBuffers[index]
  }

  setClickVolume(volume: number): void {
    this.clickVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.5
    if (this.ctx) this.clickGain!.gain.setTargetAtTime(this.clickVolume * CLICK_GAIN, this.ctx.currentTime, 0.012)
  }

  setMetronome(beats: number[] | null): void {
    this.metronomeBeats = beats ?? []
    this.stopMetronomeSources()
    if (this.playing) this.scheduleMetronome()
  }

  private scheduleMetronome(): void {
    if (!this.ctx) return
    const duration = this.trackDuration()
    for (const beat of this.metronomeBeats) {
      const when = this.anchorCtx + (beat - this.anchorYt) / this.rate
      if (beat < this.anchorYt || beat >= duration || when < this.ctx.currentTime) continue
      const source = this.ctx.createBufferSource()
      source.buffer = this.clickBuffer(false)
      source.connect(this.clickGain!)
      source.onended = () => {
        source.disconnect()
        this.metronomeSources = this.metronomeSources.filter(node => node !== source)
      }
      source.start(when)
      this.metronomeSources.push(source)
    }
  }

  private stopMetronomeSources(): void {
    for (const source of this.metronomeSources) {
      try { source.stop() } catch {}
      source.disconnect()
    }
    this.metronomeSources = []
  }

  async align(time: number, count?: CountIn): Promise<boolean> {
    const request = ++this.alignRequest
    this.stopSources()
    this.anchorYt = time
    this.aligning = false
    if (!this.ctx || !this.playing || !this.hasBuffers()) return true
    this.aligning = true
    try {
      const ctx = this.ctx
      const latency = this.pitchSetup?.latency ?? 0
      if (this.pitchSetup) {
        const created = this.pitchSetup.create()
        const pitch = created instanceof Promise ? await created : created
        if (request !== this.alignRequest) { pitch.dispose(); return false }
        this.pitch = pitch
        this.pitch.node.connect(this.master!)
        for (const pan of Object.values(this.panners)) {
          pan?.disconnect()
          pan?.connect(this.pitch.node)
        }
      }
      let startAt = ctx.currentTime + 0.04 + latency
      if (count) {
        const interval = 60 / count.bpm
        this.count = { start: startAt, interval, beatsPerBar: count.beatsPerBar }
        for (let i = 0; i < count.bars * count.beatsPerBar; i++) {
          const click = ctx.createBufferSource()
          click.buffer = this.clickBuffer(i % count.beatsPerBar === 0)
          click.connect(this.clickGain!)
          click.start(startAt + i * interval)
          this.sources.push(click)
        }
        startAt += count.bars * count.beatsPerBar * interval
      }
      for (const id of Object.keys(this.buffers) as StemId[]) {
        const buf = this.buffers[id]
        if (!buf) continue
        const gain = this.getGain(id)
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.playbackRate.value = this.rate
        src.connect(gain)
        src.start(startAt - latency, Math.min(Math.max(0, time), Math.max(0, buf.duration - 0.01)))
        this.sources.push(src)
      }
      this.anchorCtx = startAt
      this.aligning = false
      this.scheduleMetronome()
      return true
    } catch (error) {
      if (request !== this.alignRequest) return false
      this.stopAll()
      throw error
    }
  }

  expected(): number {
    if (!this.ctx || !this.playing || this.aligning) return this.anchorYt
    return this.anchorYt + Math.max(0, this.ctx.currentTime - this.anchorCtx) * this.rate
  }

  trackDuration(): number {
    let d = 0
    for (const buf of Object.values(this.buffers)) {
      if (buf && buf.duration > d) d = buf.duration
    }
    return d
  }

  applyMix(
    vols: Partial<Record<StemId, number>>,
    mutes: Set<MixChannelId>,
    solos: Set<MixChannelId>,
    masterVol: number,
    pans: StemPanMap = {}
  ): void {
    this.mix = {
      vols: { ...vols }, pans: { ...pans },
      mutes: new Set(mutes), solos: new Set(solos), master: masterVol
    }
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const id of Object.keys(this.buffers) as StemId[]) {
      this.getGain(id).gain.setTargetAtTime(this.stemVolume(id), now, 0.012)
      this.panners[id]?.pan.setTargetAtTime(pans[id] ?? 0, now, 0.012)
    }
    this.clickPanner?.pan.setTargetAtTime(pans.metronome ?? 0, now, 0.012)
    this.master?.gain.setTargetAtTime(masterVol, now, 0.012)
  }

  stopAll(): void {
    ++this.request
    ++this.rateRequest
    ++this.alignRequest
    this.aligning = false
    this.playing = false
    this.stopSources()
  }

  private stopSources(): void {
    this.count = null
    this.stopMetronomeSources()
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {}
      try {
        s.disconnect()
      } catch {}
    }
    this.sources = []
    if (this.pitch) {
      this.pitch.dispose()
      this.pitch = null
      for (const pan of Object.values(this.panners)) {
        pan?.disconnect()
        pan?.connect(this.master!)
      }
    }
  }
}

export const engine = new StemEngine()
