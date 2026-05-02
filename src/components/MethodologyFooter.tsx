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
            <strong>Source.</strong> U.S. Census Bureau, LEHD LODES Version 8 —
            Origin–Destination (OD), Workplace Area Characteristics (WAC), and
            Residence Area Characteristics (RAC); Colorado, 2002–2023, job
            type JT00 ("All Jobs"). JT00 covers primary and secondary jobs
            (a worker with two jobs is counted twice) and federal civilian
            jobs, but excludes self-employed, military, and informal labor.
            LODES typically releases two years after the reference year; the
            2023 vintage shown here was released by Census in 2025.
          </p>
          <p className="mb-1.5">
            <strong>Study area.</strong> The 11 valley anchor ZIPs span the
            Colorado River and Roaring Fork corridors from De Beque to Aspen:
            81601 Glenwood Springs, 81611 Aspen, 81615 Snowmass Village,
            81621 Basalt, 81623 Carbondale, 81630 De Beque, 81635 Parachute,
            81647 New Castle, 81650 Rifle, 81652 Silt, and 81654 Old
            Snowmass.
          </p>
          <p className="mb-1.5">
            <strong>Universe.</strong> Workers who live and work in the same
            anchor ZIP ("within-ZIP") count once toward inbound universe and
            once toward outbound universe — they are surfaced as a separate
            within-ZIP row in stat callouts so the two universes don't
            appear to double-count. RAC totals are typically slightly larger
            than outbound universe because RAC counts all employed residents
            while outbound is restricted to Colorado-employed residents (see
            Coverage gaps below).
          </p>
          <p className="mb-1.5">
            <strong>Top-N + residual.</strong> Each workplace ZIP shows its
            top-10 home ZIPs in the side panel (top-8 in corridor tooltips)
            plus an "All Other Locations" residual aggregating every smaller
            origin and the off-map balance. The residual is rendered as an
            off-map node and surfaced explicitly in stat callouts. The full
            top-25 partner table is available in the underlying{' '}
            <code>od-summary.json</code> data file.
          </p>
          <p className="mb-1.5">
            <strong>Industry rollup.</strong> Industry buckets match LODES's
            published SI01–SI03 supersector axis: "Goods" includes
            Agriculture, Mining, Construction, and Manufacturing (NAICS 11,
            21, 23, 31–33); "Trade · Trans · Util" combines NAICS 22, 42,
            44–45, 48–49; "All Other Services" rolls up NAICS 51–92. This
            differs from the BLS supersector convention, which separates
            Agriculture into "Natural Resources & Mining." Buckets are
            computed in-build from the CNS01–CNS20 sector columns and
            reconciled to match the SI definitions.
          </p>
          <p className="mb-1.5">
            <strong>Coverage gaps.</strong> Outbound view ("Where do
            residents work?") resolves only to the 11 valley anchor ZIPs —
            non-valley CO destinations roll into "All Other Locations," and
            residents working in another state are excluded entirely (those
            flows are published in destination-state LEHD files not pulled
            here). Regionally this out-of-state gap is ~1–2% of total
            residents, rising to ~3–4% near state borders (De Beque).
            Inbound view symmetrically pulls only Colorado-resident origins
            for the OD layer; out-of-state workers commuting into a valley
            anchor appear in WAC totals but collapse into the inbound "All
            Other Locations" residual.
          </p>
          <p className="mb-1.5">
            <strong>Distances & corridor paths.</strong> Average commute
            distance is a worker-weighted average of OSRM-derived driving
            distance for each origin–destination ZIP pair (Haversine ×1.25
            fallback when OSRM cannot route the pair); within-ZIP
            self-flows are excluded from the average. Corridor paths shown
            in flow exports are computed via Dijkstra over a hand-authored
            corridor graph (I-70, Hwy 82, etc.) snapped to OSRM road
            geometry, with two synthetic gateway nodes (GW_E, GW_W) routing
            out-of-state and far-corner CO origins toward the appropriate
            end of the network.
          </p>
          <p className="mb-1.5">
            <strong>Pass-through commutes.</strong> The Pass-Through sheet
            in workplace exports lists OD pairs whose residence and
            workplace ZIPs flank the selected anchor longitudinally — e.g.,
            a Rifle resident working in Aspen passes through Glenwood
            Springs. Capped at 5,000 pairs per anchor per mode; excess
            collapse into a "Residual (beyond top-N)" row.
          </p>
          <p className="mb-1.5">
            <strong>Data quality.</strong> LEHD applies noise infusion and
            small-cell suppression for confidentiality; segment axes
            (age / earnings / industry) within a single OD row may sum to
            ±2 of the row's totalJobs as a result. Single-digit cell counts
            (1–5 workers) should be read as directional rather than
            precise. The build pipeline reconciles inbound flow totals
            against WAC at ±0.5% tolerance per ZIP. Resort-area workforce
            in the Aspen / Snowmass / Basalt corridor is a known LEHD
            undercount — seasonal, J-1, and 1099 contractor labor falls
            outside the QCEW UI coverage that feeds LODES, so worker counts
            in 81611, 81615, 81621, and 81654 should be treated as a
            floor, not a census.
          </p>
          <p className="mb-1.5">
            <strong>Geocoding.</strong> ZIP → city labels for ZIPs outside
            the 11 study anchors are sourced from a U.S. Census Bureau
            ZCTA-to-place crosswalk (public domain), distributed via{' '}
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
          <p className="mb-1.5">
            Basemap © CARTO · Hillshade © Mapzen Terrain Tiles (AWS Open
            Data; terrarium-encoded DEM blending JAXA AW3D30, USGS NED, ETOPO1,
            and others — see <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer" className="underline">joerd attribution</a>) · Map data © OpenStreetMap contributors
          </p>
          <p>
            <strong>Cite as:</strong> U.S. Census Bureau, Longitudinal
            Employer–Household Dynamics, LEHD Origin–Destination Employment
            Statistics (LODES), Version 8, 2023, JT00. Accessed via the
            City of Glenwood Springs Valley Behavioral Map.
          </p>
        </div>
      )}
    </div>
  );
}
