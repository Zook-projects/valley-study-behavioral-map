// Frosted-glass left dashboard tile. Composes header, mode toggle, ZIP selector,
// stats, and methodology footer. Accepts the global selection state via props.

import type { DirectionFilter, FlowRow, Mode, ZipMeta } from '../types/flow';
import type { DriveDistanceMap } from '../lib/flowQueries';
import { ModeToggle } from './ModeToggle';
import { DirectionToggle } from './DirectionToggle';
import { ZipSelector } from './ZipSelector';
import { StatsAggregated } from './StatsAggregated';
import { StatsForZip } from './StatsForZip';
import { MethodologyFooter } from './MethodologyFooter';

interface Props {
  // Active-mode dataset — used for both aggregated and per-ZIP stats. The
  // per-ZIP stats panel keeps strict mode-exclusivity; the aggregated panel
  // (Option B) renders side-by-side inbound + outbound figures and so also
  // receives the inactive-mode set below.
  flows: FlowRow[];
  // Same dataset, with the direction filter applied. Stats use this for
  // top-N corridors / totals; the unfiltered `flows` is preserved so the
  // self-flow and ALL_OTHER callouts can stay pinned across direction states.
  directionFilteredFlows: FlowRow[];
  // Both datasets — needed by StatsAggregated to render both directions in
  // each tile while highlighting the active mode.
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  directionFilteredInbound: FlowRow[];
  directionFilteredOutbound: FlowRow[];
  zips: ZipMeta[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  selectedZip: string | null;
  onSelectZip: (z: string | null) => void;
  // Optional secondary partner selection (a single row from the anchor's
  // top-N list). Plumbed through to StatsForZip; null in aggregate view.
  selectedPartner: { place: string; zips: string[] } | null;
  onSelectPartner: (p: { place: string; zips: string[] } | null) => void;
  directionFilter: DirectionFilter;
  onDirectionChange: (d: DirectionFilter) => void;
  // Quantile breaks for the corridor width × luminance legend. Recomputed
  // upstream when mode/visible flows change.
  bucketBreaks: [number, number, number, number];
  // Heaviest corridor for each mode (direction-filtered, no selection
  // narrowing). Drives the dual-rendered "Top corridor" tile in
  // StatsAggregated.
  topCorridorInbound: { label: string; total: number } | null;
  topCorridorOutbound: { label: string; total: number } | null;
  // Precomputed OSRM drive-distance lookup for the average-commute stat.
  // Optional — null falls back to Haversine × detour-factor.
  driveDistance: DriveDistanceMap | null;
}

export function DashboardTile({
  flows,
  directionFilteredFlows,
  flowsInbound,
  flowsOutbound,
  directionFilteredInbound,
  directionFilteredOutbound,
  zips,
  mode,
  onModeChange,
  selectedZip,
  onSelectZip,
  selectedPartner,
  onSelectPartner,
  directionFilter,
  onDirectionChange,
  bucketBreaks,
  topCorridorInbound,
  topCorridorOutbound,
  driveDistance,
}: Props) {
  return (
    <aside
      className="glass relative z-10 flex flex-col w-full md:w-[380px] md:h-full md:overflow-hidden"
    >
      <div className="px-5 pt-5 pb-4 space-y-4 md:flex-1 md:overflow-y-auto">
        {/* Header */}
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--accent)' }}
            >
              Movement Patterns Map · v2
            </span>
          </div>
          <h1
            className="text-[19px] font-semibold leading-tight"
            style={{ color: 'var(--text-h)', letterSpacing: '-0.01em' }}
          >
            Roaring Fork & Colorado River
            <br />
            Valley Commuters
          </h1>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            2002–2023 LEHD LODES8 · 11 workplace anchors
          </div>
        </div>

        {/* Mode toggle */}
        <ModeToggle mode={mode} onChange={onModeChange} />

        {/* Direction toggle (independent — composes with mode) */}
        <DirectionToggle value={directionFilter} onChange={onDirectionChange} />

        {/* ZIP selector */}
        <ZipSelector
          zips={zips}
          selectedZip={selectedZip}
          onSelectZip={onSelectZip}
        />

        {/* Stats */}
        <div>
          {selectedZip ? (
            <StatsForZip
              flows={flows}
              directionFilteredFlows={directionFilteredFlows}
              flowsInbound={flowsInbound}
              directionFilter={directionFilter}
              zips={zips}
              selectedZip={selectedZip}
              mode={mode}
              selectedPartner={selectedPartner}
              onSelectPartner={onSelectPartner}
              onReset={() => onSelectZip(null)}
            />
          ) : (
            <StatsAggregated
              flowsInbound={flowsInbound}
              flowsOutbound={flowsOutbound}
              directionFilteredInbound={directionFilteredInbound}
              directionFilteredOutbound={directionFilteredOutbound}
              directionFilter={directionFilter}
              mode={mode}
              topCorridorInbound={topCorridorInbound}
              topCorridorOutbound={topCorridorOutbound}
              zips={zips}
              driveDistance={driveDistance}
            />
          )}
        </div>

        {/* Year toggle (locked, future-ready) */}
        <div
          className="rounded-md px-2.5 py-1.5 flex items-center justify-between"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--panel-border)',
          }}
        >
          <span
            className="text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Vintage
          </span>
          <span className="text-xs tnum" style={{ color: 'var(--text-h)' }}>
            2002–2023
          </span>
        </div>
      </div>

      {/* Footer */}
      <div
        className="px-5 py-3.5 border-t"
        style={{ borderColor: 'var(--panel-border)' }}
      >
        <MethodologyFooter
          bucketBreaks={bucketBreaks}
          amberSwatches={selectedZip == null}
        />
      </div>
    </aside>
  );
}
