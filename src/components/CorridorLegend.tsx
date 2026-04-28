// CorridorLegend — visual key for the width × luminance corridor encoding.
// Reads the live bucket breaks (recomputed per active mode) so the threshold
// values shown match what the map is rendering.

import { CORRIDOR_BUCKET_STYLES, type CorridorBucket } from '../lib/arcMath';
import { fmtInt } from '../lib/format';

interface Props {
  breaks: [number, number, number, number];
  // When true (no ZIP selected), swatches render in amber to match the
  // aggregate-view canvas color. When false, the monochrome luminance ramp
  // is used to match the selection-view encoding.
  amberSwatches: boolean;
}

export function CorridorLegend({ breaks, amberSwatches }: Props) {
  const rows: Array<{ bucket: CorridorBucket; label: string }> = [
    { bucket: 5, label: `≥ ${fmtInt(breaks[3])}` },
    { bucket: 4, label: `${fmtInt(breaks[2])} – ${fmtInt(breaks[3])}` },
    { bucket: 3, label: `${fmtInt(breaks[1])} – ${fmtInt(breaks[2])}` },
    { bucket: 2, label: `${fmtInt(breaks[0])} – ${fmtInt(breaks[1])}` },
    { bucket: 1, label: `< ${fmtInt(breaks[0])}` },
  ];

  return (
    <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
      <div
        className="text-[10px] font-medium uppercase tracking-wider mb-2"
        style={{ color: 'var(--text-dim)' }}
      >
        Workers per corridor
      </div>
      <ul className="space-y-1.5">
        {rows.map(({ bucket, label }) => {
          const s = CORRIDOR_BUCKET_STYLES[bucket];
          return (
            <li key={bucket} className="flex items-center gap-3">
              <svg width="56" height="12" aria-hidden="true">
                <line
                  x1="2"
                  y1="6"
                  x2="54"
                  y2="6"
                  stroke={amberSwatches ? 'var(--accent)' : s.color}
                  strokeWidth={s.width}
                  strokeOpacity={s.opacity}
                  strokeLinecap="round"
                />
              </svg>
              <span className="tnum" style={{ color: 'var(--text)' }}>
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
