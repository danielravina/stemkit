import type { TempoAnalysis, TempoPoint, TempoSettings } from '../../../shared/types'
export { manualBeats } from '../../../shared/metronome.ts'

export function tempoAt(points: TempoPoint[], position: number): number | null {
  let bpm: number | null = null
  for (const point of points) {
    if (point.start > position) break
    bpm = point.bpm
  }
  return bpm
}

export class TempoDetector {
  private cache = new Map<string, TempoAnalysis>()
  private pending: { id: string; reject: (reason: Error) => void } | null = null

  cancel(): void {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    pending.reject(new DOMException('Tempo analysis cancelled', 'AbortError'))
    void window.stemkit.cancelTempoAnalysis(pending.id).catch(() => {})
  }

  async detect(songId: string, position: number): Promise<number | null> {
    return tempoAt((await this.analyze(songId)).points, position)
  }

  async analyze(songId: string): Promise<TempoAnalysis> {
    this.cancel()
    const cached = this.cache.get(songId)
    if (cached) return cached
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.pending = { id, reject }
      void window.stemkit.analyzeTempo(songId, id).then(analysis => {
        if (this.pending?.id !== id) return
        this.pending = null
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(songId, analysis)
        resolve(analysis)
      }).catch(error => {
        if (this.pending?.id !== id) return
        this.pending = null
        reject(error)
      })
    })
  }
}

export function practiceRate(tempo: TempoSettings, analysis: TempoAnalysis | null): number {
  const base = tempo.sourceBpm ?? analysis?.points[0]?.bpm
  return tempo.mode === 'manual' && base ? (tempo.manualBpm ?? base) / base : 1
}

export async function playbackAnalysis(detector: TempoDetector, songId: string, allowMissing: boolean): Promise<TempoAnalysis> {
  try {
    return await detector.analyze(songId)
  } catch (error) {
    if (!allowMissing || (error instanceof Error && error.name === 'AbortError')) throw error
    return { points: [], beats: [] }
  }
}
