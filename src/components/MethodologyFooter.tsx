// Methodology footer — citation, vintage, residual-bucket caveat, and the
// corridor width × luminance legend. Collapsed by default; users expand on
// demand to keep dashboard chrome compact.

import { useState } from 'react';
import { CorridorLegend } from './CorridorLegend';

interface Props {
  bucketBreaks: [number, number, number, number];
  amberSwatches: boolean;
}

export function MethodologyFooter({ bucketBreaks, amberSwatches }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="text-[10px] leading-relaxed"
      style={{ color: 'var(--text-dim)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between font-medium focus:outline-none focus-visible:ring-1 rounded-sm"
        style={{ color: 'var(--text)' }}
      >
        <span>Methodology</span>
        <span
          className="text-[16px] leading-none tnum"
          style={{ color: 'var(--text-dim)' }}
          aria-hidden="true"
        >
          {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded && (
        <div className="mt-2.5">
          <div className="mb-3">
            <CorridorLegend breaks={bucketBreaks} amberSwatches={amberSwatches} />
          </div>
          <p className="mb-1.5">
            Source: U.S. Census Bureau, LEHD OnTheMap — Zip Code Work Area Analysis,
            All Jobs, 2023 vintage.
          </p>
          <p className="mb-1.5">
            Each anchor workplace ZIP shows its top-25 home ZIPs plus an
            "All Other Locations" residual. The residual is rendered as an
            off-map node and surfaced explicitly in stat callouts. LEHD applies
            noise injection and small-cell suppression for confidentiality.
          </p>
          <p className="mb-1.5">
            Outbound view ("Where do residents work?") resolves only to the 11
            valley anchor ZIPs. Non-valley work destinations are outside this slice.
          </p>
          <p>
            Basemap © CARTO · Hillshade © Mapzen Terrain Tiles (AWS Open
            Data) · Map data © OpenStreetMap contributors
          </p>
        </div>
      )}
    </div>
  );
}
