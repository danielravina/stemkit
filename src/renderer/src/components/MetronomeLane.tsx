import { StemLane } from './StemLane'

interface Props {
  muted: boolean
  soloed: boolean
  audible: boolean
  disabled: boolean
  onToggleMute: () => void
  onToggleSolo: () => void
  volume: number
  onVolume: (volume: number) => void
  onVolumeCommit: () => void
  onExport: () => void
  pan: number
  onPan: (pan: number) => void
  peaks: Float32Array | null
  duration: number
  playing: boolean
  getPosition: () => number
  onSeek: (seconds: number) => void
}

export function MetronomeLane({ peaks, ...props }: Props): React.ReactElement {
  return <StemLane
    {...props}
    meta={{ label: 'Metronome', color: '#FB923C', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-4 h-4" aria-hidden="true">
        <path d="M8 3h8l4 18H4L8 3Z" strokeLinejoin="round" />
        <path d="m12 17 5-10M8 17h8" strokeLinecap="round" />
      </svg>
    ) }}
    buffer={null}
    waveformPeaks={peaks}
    volumeLabel="Click volume"
  />
}
