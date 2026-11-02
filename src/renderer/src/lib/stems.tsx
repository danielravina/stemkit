import type { StemId } from '../../../shared/types'
import { MicIcon, DrumIcon, BassIcon, WaveIcon, PianoIcon, GuitarIcon, MetronomeIcon } from '../components/Icons'

export interface StemMeta {
  id: StemId
  label: string
  color: string
  icon: React.ReactNode
}

const ALL_META: Record<StemId, StemMeta> = {
  click: { id: 'click', label: 'click', color: '#F59E0B', icon: <MetronomeIcon /> },
  vocals: { id: 'vocals', label: 'vocals', color: '#A78BFA', icon: <MicIcon /> },
  drums: { id: 'drums', label: 'drums', color: '#F87171', icon: <DrumIcon /> },
  bass: { id: 'bass', label: 'bass', color: '#60A5FA', icon: <BassIcon /> },
  guitar: { id: 'guitar', label: 'guitar', color: '#F472B6', icon: <GuitarIcon /> },
  piano: { id: 'piano', label: 'piano', color: '#FBBF24', icon: <PianoIcon /> },
  other: { id: 'other', label: 'other', color: '#34D399', icon: <WaveIcon /> }
}

// Instruments separated by Demucs from the source audio
export const SEPARABLE_STEMS: StemId[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

// Order of lanes rendered in the player (Click at the very top)
export const PLAYER_STEM_ORDER: StemId[] = ['click', 'vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

export { ALL_META as STEM_INFO, PLAYER_STEM_ORDER as PREFERRED_ORDER }

export function buildStemMeta(available: StemId[]): StemMeta[] {
  return PLAYER_STEM_ORDER.filter((id) => available.includes(id)).map((id) => ALL_META[id])
}
