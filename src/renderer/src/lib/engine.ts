import type { StemId, StemPanMap, BeatGridData } from '../../../shared/types'

export type BufferMap = Partial<Record<StemId, AudioBuffer>>

export async function decodePayload(
  payload: Record<string, Uint8Array>
): Promise<BufferMap> {
  const ctx = new AudioContext()
  void ctx.resume()
  const ids = Object.keys(payload)
  try {
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
  } finally {
    // this context exists only to decode, and every open one holds an audio
    // stream + engine of its own: leaving it running leaks one per song
    // visited. AudioBuffers outlive the context that made them, so the
    // playback engine (a separate context) still uses them
    void ctx.close()
  }
}

export class StemEngine {
  private ctx: AudioContext | null = null
  private buffers: BufferMap = {}
  private gains: Partial<Record<StemId, GainNode>> = {}
  private panners: Partial<Record<StemId, StereoPannerNode>> = {}
  private mix = {
    vols: {} as Partial<Record<StemId, number>>,
    pans: {} as StemPanMap,
    mutes: new Set<StemId>(),
    solos: new Set<StemId>(),
    master: 0.9
  }
  private master: GainNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private playing = false
  private anchorYt = 0
  private anchorCtx = 0
  rate = 1

  // Metronome state
  private beatGrid: BeatGridData | null = null
  private metronomeEnabled = false
  private metronomeVolume = 0.7
  private metronomeGain: GainNode | null = null
  private metronomeTimer: ReturnType<typeof setInterval> | null = null
  private lastScheduledBeatIdx = -1
  private onBeatCallback: ((beatIndex: number, isDownbeat: boolean) => void) | null = null

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.mix.master
      this.master.connect(this.ctx.destination)

      this.metronomeGain = this.ctx.createGain()
      this.metronomeGain.gain.value = this.metronomeVolume
      this.metronomeGain.connect(this.master)
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
      pan.connect(this.master!)
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
    for (const gain of Object.values(this.gains)) gain?.disconnect()
    for (const pan of Object.values(this.panners)) pan?.disconnect()
    this.gains = {}
    this.panners = {}
    this.mix = { vols: {}, pans: {}, mutes: new Set(), solos: new Set(), master: 0.9 }
    this.buffers = buffers
  }

  setBeatGrid(grid: BeatGridData | null): void {
    this.beatGrid = grid
    this.lastScheduledBeatIdx = -1
  }

  getBeatGrid(): BeatGridData | null {
    return this.beatGrid
  }

  setMetronomeEnabled(enabled: boolean): void {
    this.metronomeEnabled = enabled
    if (this.playing) {
      if (enabled) {
        this.startMetronomeScheduler()
      } else {
        this.stopMetronomeScheduler()
      }
    }
  }

  isMetronomeEnabled(): boolean {
    return this.metronomeEnabled
  }

  setMetronomeVolume(vol: number): void {
    this.metronomeVolume = Math.max(0, Math.min(1, vol))
    if (this.metronomeGain && this.ctx) {
      this.metronomeGain.gain.setTargetAtTime(this.metronomeVolume, this.ctx.currentTime, 0.01)
    }
  }

  onBeat(cb: ((beatIndex: number, isDownbeat: boolean) => void) | null): void {
    this.onBeatCallback = cb
  }

  private playClick(time: number, isDownbeat: boolean): void {
    if (!this.ctx || !this.metronomeGain) return
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()

    osc.type = isDownbeat ? 'sine' : 'triangle'
    osc.frequency.setValueAtTime(isDownbeat ? 1600 : 900, time)

    const peak = isDownbeat ? 1.0 : 0.65
    gain.gain.setValueAtTime(peak, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03)

    osc.connect(gain)
    gain.connect(this.metronomeGain)

    osc.start(time)
    osc.stop(time + 0.035)
  }

  private startMetronomeScheduler(): void {
    this.stopMetronomeScheduler()
    if (!this.metronomeEnabled || !this.beatGrid?.grid?.length) return

    this.metronomeTimer = setInterval(() => {
      this.scheduleUpcomingBeats()
    }, 25)
  }

  private stopMetronomeScheduler(): void {
    if (this.metronomeTimer) {
      clearInterval(this.metronomeTimer)
      this.metronomeTimer = null
    }
  }

  private scheduleUpcomingBeats(): void {
    if (!this.ctx || !this.playing || !this.metronomeEnabled || !this.beatGrid?.grid?.length) return
    if (this.buffers['click']) return

    const trackTime = this.expected()
    const lookAheadSec = 0.15
    const windowEnd = trackTime + lookAheadSec

    const grid = this.beatGrid.grid
    for (let i = 0; i < grid.length; i++) {
      const b = grid[i]
      if (b.time < trackTime - 0.05) continue
      if (b.time > windowEnd) break

      if (b.index > this.lastScheduledBeatIdx) {
        const audioTime = this.anchorCtx + (b.time - this.anchorYt) / Math.max(0.1, this.rate)
        if (audioTime >= this.ctx.currentTime - 0.02) {
          const clickTime = Math.max(this.ctx.currentTime, audioTime)
          this.playClick(clickTime, b.is_downbeat)
          this.onBeatCallback?.(b.index, b.is_downbeat)
        }
        this.lastScheduledBeatIdx = b.index
      }
    }
  }

  private resetBeatScheduler(targetTime: number): void {
    if (!this.beatGrid?.grid?.length) {
      this.lastScheduledBeatIdx = -1
      return
    }
    const grid = this.beatGrid.grid
    let idx = -1
    for (let i = 0; i < grid.length; i++) {
      if (grid[i].time < targetTime) {
        idx = grid[i].index
      } else {
        break
      }
    }
    this.lastScheduledBeatIdx = idx
  }

  private stemVolume(id: StemId): number {
    const { vols, mutes, solos } = this.mix
    if (id === 'click') {
      return !mutes.has('click') ? vols['click'] ?? 1 : 0
    }
    return !mutes.has(id) && (solos.size === 0 || solos.has(id)) ? vols[id] ?? 1 : 0
  }

  hasBuffers(): boolean {
    return Object.keys(this.buffers).length > 0
  }

  setPlaying(playing: boolean, time: number): void {
    if (playing) this.resume()
    this.playing = playing
    this.align(time)

    if (playing) {
      this.startMetronomeScheduler()
    } else {
      this.stopMetronomeScheduler()
    }
  }

  align(time: number): void {
    this.stopSources()
    this.anchorYt = time
    this.resetBeatScheduler(time)

    if (!this.ctx || !this.playing || !this.hasBuffers()) return
    const ctx = this.ctx
    const startAt = ctx.currentTime + 0.04
    for (const id of Object.keys(this.buffers) as StemId[]) {
      const buf = this.buffers[id]
      if (!buf) continue
      const gain = this.getGain(id)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = this.rate
      src.connect(gain)
      src.start(startAt, Math.min(Math.max(0, time), Math.max(0, buf.duration - 0.01)))
      this.sources.push(src)
    }
    this.anchorCtx = startAt
  }

  expected(): number {
    if (!this.ctx || !this.playing) return this.anchorYt
    return this.anchorYt + (this.ctx.currentTime - this.anchorCtx) * this.rate
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
    mutes: Set<StemId>,
    solos: Set<StemId>,
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
    this.master?.gain.setTargetAtTime(masterVol, now, 0.012)
  }

  stopAll(): void {
    this.playing = false
    this.stopMetronomeScheduler()
    this.stopSources()
  }

  // hand back the decoded audio: the singleton engine would otherwise pin the
  // last viewed song for the rest of the session
  release(): void {
    this.stopAll()
    this.buffers = {}
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {}
      try {
        s.disconnect()
      } catch {}
    }
    this.sources = []
  }
}

export const engine = new StemEngine()
