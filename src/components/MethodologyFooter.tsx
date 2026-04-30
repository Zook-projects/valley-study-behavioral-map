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
            Source: U.S. Census Bureau, LEHD LODES8 — Origin–Destination,
            Workplace Area Characteristics, and Residence Area Characteristics;
            Colorado, 2002–2023, JT00 (All Jobs). Latest year: 2023.
          </p>
          <p className="mb-1.5">
            Each workplace ZIP code shows its top-10 home ZIPs in the side
            panel (top-8 in corridor tooltips) plus an "All Other Locations"
            residual aggregating every smaller origin and the off-map balance.
            The residual is rendered as an off-map node and surfaced explicitly
            in stat callouts. The full top-25 partner table is available in the
            underlying <code>od-summary.json</code> data file. LEHD applies
            noise injection and small-cell suppression for confidentiality.
          </p>
          <p className="mb-1.5">
            Industry buckets follow LODES's published SI01–SI03 axis: "Goods"
            includes Agriculture, Mining, Construction, and Manufacturing
            (NAICS 11, 21, 23, 31–33); "Trade · Trans · Util" combines NAICS
            22, 42, 44–45, 48–49; "All Other Services" rolls up NAICS 51–92.
            This differs from the BLS supersector convention, which separates
            Agriculture into "Natural Resources & Mining."
          </p>
          <p className="mb-1.5">
            Outbound view ("Where do residents work?") resolves only to the 11
            valley ZIP codes. Non-valley work destinations are outside this
            slice. Outbound counts also exclude residents working in another
            state, since LEHD publishes those flows in other states' files
            which are not pulled here — regionally this gap is ~1–2% of total
            residents, rising to ~3–4% near state borders (De Beque).
          </p>
          <p className="mb-1.5">
            ZIP code → city labels for ZIPs outside the 11 study anchors are
            sourced from a U.S. Census Bureau ZCTA-to-place crosswalk (public
            domain), distributed via{' '}
            <a
              href="https://github.com/scpike/us-state-county-zip"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              scpike/us-state-county-zip
            </a>
            . Anchor place names use the project's curated overrides; ZCTAs
            the Census source has no named place for fall back to the bare
            ZIP code in the export.
          </p>
          <p>
            Basemap © CARTO · Hillshade © Mapzen Terrain Tiles (AWS Open
            Data; terrarium-encoded DEM blending JAXA AW3D30, USGS NED, ETOPO1,
            and others — see <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer" className="underline">joerd attribution</a>) · Map data © OpenStreetMap contributors
          </p>
        </div>
      )}
    </div>
  );
}
