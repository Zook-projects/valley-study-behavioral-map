// Aggregated-state stat tiles — shown when no ZIP is selected.
//
// Inbound-only by editorial choice: for understanding commuting patterns in
// the valleys, the inbound dataset is the more complete view. It captures
// workers commuting in from outside the 11 anchor ZIPs (the `ALL_OTHER`
// bucket), aligns with how transit and corridor work are planned ("toward
// destination"), and is the standard economic-development framing. The
// Mode toggle still affects the map and the per-ZIP detail panel; the
// aggregate left-panel stats stay pinned to inbound regardless of toggle
// state, which removes the narrative whiplash that comes from swapping
// between two different universes (jobs in anchors vs residents of anchors).
//
// When a direction filter (East/West) is active, totals/top-corridor stats
// re-aggregate against the filtered inbound set. The "Outside of the
// Region" tile remains pinned to the unfiltered set because direction is
// not meaningful for the off-map residual.

import type { DirectionFilter, FlowRow, ZipMeta } from '../types/flow';
import { computeAggregated, meanCommuteMiles, type DriveDistanceMap } from '../lib/flowQueries';
import { fmtInt, fmtPct } from '../lib/format';

interface Props {
  // Inbound-only props are read; the outbound + mode props are accepted to
  // keep the DashboardTile call site stable but are intentionally ignored.
  flowsInbound: FlowRow[];
  flowsOutbound?: FlowRow[];
  directionFilteredInbound: FlowRow[];
  directionFilteredOutbound?: FlowRow[];
  directionFilter: DirectionFilter;
  mode?: unknown;
  topCorridorInbound: { label: string; total: number } | null;
  topCorridorOutbound?: { label: string; total: number } | null;
  // ZIP centroids for the worker-weighted mean commute distance stat.
  zips: ZipMeta[];
  // Precomputed OSRM drive-distance lookup. Null = use Haversine fallback only.
  driveDistance: DriveDistanceMap | null;
}

function StatRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="py-2.5 border-b last:border-0" style={{ borderColor: 'var(--rule)' }}>
      <div
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-xl font-semibold tnum" style={{ color: 'var(--text-h)' }}>
          {value}
        </div>
        {sub && (
          <div className="text-xs tnum" style={{ color: 'var(--text-dim)' }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

export function StatsAggregated({
  flowsInbound,
  directionFilteredInbound,
  directionFilter,
  topCorridorInbound,
  zips,
  driveDistance,
}: Props) {
  // Headline numbers respect the direction filter.
  const summary = computeAggregated(directionFilteredInbound);
  // ALL_OTHER share is read from the unfiltered set — direction is not
  // meaningful for the non-spatial residual.
  const unfiltered = computeAggregated(flowsInbound);
  // Average commute distance — pinned to the unfiltered inbound set per
  // "all the OD data" (direction-agnostic). Uses precomputed OSRM
  // drive-distance when available; falls back to Haversine × detour factor.
  const avgMiles = meanCommuteMiles(flowsInbound, zips, driveDistance ?? undefined);
  const distanceSub = driveDistance
    ? 'worker-weighted, road miles, cross-ZIP only'
    : 'worker-weighted, straight-line × 1.25, cross-ZIP only';

  const filterActive = directionFilter !== 'all';

  return (
    <div>
      <StatRow
        label="Total Workers"
        value={fmtInt(summary.totalWorkers)}
        sub="across the 11 workplace anchors"
      />

      <StatRow
        label="Cross-ZIP commute share"
        value={fmtPct(summary.crossZipShare)}
        sub="of mapped workforce commutes"
      />

      <StatRow
        label="Average commute distance"
        value={`${avgMiles.toFixed(1)} mi`}
        sub={distanceSub}
      />

      {topCorridorInbound && (
        <StatRow
          label="Top corridor"
          value={fmtInt(topCorridorInbound.total)}
          sub={topCorridorInbound.label}
        />
      )}

      {summary.topOutbound && (
        <StatRow
          label="Top origin–destination pair"
          value={fmtInt(summary.topOutbound.workerCount)}
          sub={`${summary.topOutbound.originPlace} → ${summary.topOutbound.destPlace}`}
        />
      )}

      <StatRow
        label="Outside of the Region"
        value={fmtPct(unfiltered.allOtherShare)}
        sub={
          filterActive
            ? 'workforce from outside of the study area · direction filter N/A'
            : 'workforce from outside of the study area'
        }
      />
    </div>
  );
}
