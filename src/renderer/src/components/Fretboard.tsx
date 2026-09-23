import type { ChordVoicing } from '../lib/chords'

interface Props {
  voicing: ChordVoicing
  // capo: fret where capo sits (0 = no capo). When >0, diagram shows shape relative to capo
  // and renders a capo bar. The voicing's frets are already the SHAPE (not concert pitch).
  capo?: number
  width?: number
  height?: number
}

export function Fretboard({ voicing, capo = 0, width = 150, height = 96 }: Props): React.ReactElement {
  // voicing.frets are shape frets (0 = open relative to capo/nut). If capo>0, the nut is the capo.
  const shapeFrets = voicing.frets
  const hasCapo = capo > 0
  const shapeBar = voicing.bar // shape barre fret, relative to capo

  const strings = 6
  const fretsToShow = 5

  // Determine window: shape's lowest fretted >0, or capo+1 if barre there
  const sounding = shapeFrets.filter((f): f is number => f >= 0)
  const fretted = sounding.filter(f => f > 0)
  const minFret = fretted.length ? Math.min(...fretted) : 0
  // With capo, the capo itself is at shape fret 0 edge; if all open, still show capo at 0 line
  // Otherwise shift window when barre/shape sits high
  // Keep capo visible: if capo>0 and shape min is high, window starts at 0 (capo) still
  const startShapeFret = hasCapo ? 0 : (minFret >= 3 ? minFret : 0)
  // If shape barre is at high fret, ensure it stays in window
  const endShape = startShapeFret + fretsToShow

  const padL = 6, padR = 6, padT = 14, padB = 2
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const stringGap = innerW / (strings - 1)
  const fretGap = innerH / fretsToShow

  const sx = (s: number) => padL + s * stringGap
  const fyShape = (f: number) => padT + Math.max(0, f - startShapeFret) * fretGap

  void capo // used in fyShape/start logic above; keep param referenced
  // Fret numbers shown: if window at 0, show 1 or capo+1
  const labelFret = hasCapo ? capo + 1 : startShapeFret + 1

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block select-none">
      <rect x={padL - 2} y={padT} width={innerW + 4} height={innerH} rx={6} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
      {/* frets (shape frets) */}
      {Array.from({ length: fretsToShow + 1 }).map((_, i) => {
        const f = startShapeFret + i
        const y = fyShape(f)
        const isNut = f === 0
        const isCapoLine = hasCapo && f === 0
        return <line key={i} x1={padL} x2={padL + innerW} y1={y} y2={y} stroke={isCapoLine ? 'rgba(251,191,36,0.95)' : isNut ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.16)'} strokeWidth={isCapoLine ? 4 : isNut ? 3.5 : 1} />
      })}
      {/* capo label */}
      {hasCapo && (
        <text x={padL - 2} y={padT + 6} fontSize={7} fill="rgba(251,191,36,0.95)" fontWeight={700} textAnchor="start">capo {capo}</text>
      )}
      {/* strings */}
      {Array.from({ length: strings }).map((_, s) => (
        <line key={s} x1={sx(s)} x2={sx(s)} y1={padT} y2={padT + innerH} stroke="rgba(255,255,255,0.28)" strokeWidth={s === 0 || s === 5 ? 1.6 : 1} />
      ))}
      {/* fret numbers */}
      <text x={padL + innerW + 3} y={fyShape(startShapeFret + 1) - 2} fontSize={8} fill="rgba(255,255,255,0.35)" fontFamily="ui-monospace, monospace">{labelFret}</text>

      {/* barre (shape barre) */}
      {shapeBar && (() => {
        if (shapeBar.fret < startShapeFret || shapeBar.fret > endShape) return null as any
        const y = fyShape(shapeBar.fret) - fretGap / 2
        const x0 = sx(shapeBar.from)
        const x1 = sx(shapeBar.to)
        return <rect x={x0 - 5} y={y - 6} width={(x1 - x0) + 10} height={12} rx={6} fill="rgba(167,139,250,0.92)" />
      })()}
      {/* capo bar (full across) — drawn as distinct gold bar at fret 0 line */}
      {hasCapo && (
        <rect x={padL} y={padT - 7} width={innerW} height={7} rx={3} fill="rgba(251,191,36,0.92)" />
      )}

      {/* open / mute indicators (shape) */}
      {shapeFrets.map((f, s) => {
        const x = sx(s)
        if (f === -1) {
          return <text key={s} x={x} y={padT - 3} fontSize={9} fill="rgba(255,255,255,0.45)" textAnchor="middle" fontWeight={700}>×</text>
        }
        if (f === 0) {
          // with capo, open means at capo — show as filled at capo, not hollow nut
          if (hasCapo) return null // open at capo is covered by capo bar, no hollow circle needed
          return <circle key={s} cx={x} cy={padT - 5} r={5} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1.2} />
        }
        return null
      })}
      {/* dots (shape frets >0) */}
      {shapeFrets.map((f, s) => {
        if (f <= 0) return null
        const x = sx(s)
        if (f < startShapeFret || f > endShape) return null
        const y = fyShape(f) - fretGap / 2
        const isBarCovered = !!shapeBar && shapeBar.fret === f && s >= shapeBar.from && s <= shapeBar.to
        if (isBarCovered) return null
        // if at capo fret? not dots (capo is bar)
        return <circle key={s} cx={x} cy={y} r={6} fill="#fff" />
      })}
      <text x={width / 2} y={height - 1} fontSize={7} fill="rgba(255,255,255,0.35)" textAnchor="middle" fontFamily="ui-sans-serif, system-ui">{voicing.name}</text>
    </svg>
  )
}
