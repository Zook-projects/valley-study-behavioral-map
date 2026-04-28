// Frosted-glass left dashboard tile. Composes header, mode toggle, ZIP selector,
// stats, and methodology footer. Accepts the global selection state via props.

import type { DirectionFilter, FlowRow, Mode, ZipMeta } from '../types/flow';
import { ModeToggle } from './ModeToggle';
import { DirectionToggle } from './DirectionToggle';
import { ZipSelector } from './ZipSelector';
import { StatsAggregated } from './StatsAggregated';
import { StatsForZip } from './StatsForZip';
import { MethodologyFooter } from './MethodologyFooter';

interface Props {
  // Active-mode dataset — used for both aggregated and per-ZIP stats. Mode
  // exclusivity is a hard rule: stats panels never read the inactive mode.
  flows: FlowRow[];
  // Same dataset, with the direction filter applied. Stats use this for
  // top-N corridors / totals; the unfiltered `flows` is preserved so the
  // self-flow and ALL_OTHER callouts can stay pinned across direction states.
  directionFilteredFlows: FlowRow[];
  zips: ZipMeta[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  selectedZip: string | null;
  onSelectZip: (z: string | null) => void;
  directionFilter: DirectionFilter;
  onDirectionChange: (d: DirectionFilter) => void;
  // Quantile breaks for the corridor width × luminance legend. Recomputed
  // upstream when mode/visible flows change.
  bucketBreaks: [number, number, number, number];
  // Heaviest corridor edge in the active mode + direction filter, computed
  // upstream from the same aggregation the map renders.
  topCorridor: { label: string; total: number } | null;
}

export function DashboardTile({
  flows,
  directionFilteredFlows,
  zips,
  mode,
  onModeChange,
  selectedZip,
  onSelectZip,
  directionFilter,
  onDirectionChange,
  bucketBreaks,
  topCorridor,
}: Props) {
  return (
    <aside
      className="glass relative z-10 flex flex-col h-full overflow-hidden"
      style={{ width: 380 }}
    >
      <div className="flex-1 overflow-y-auto px-5 pt-5 pb-4 space-y-4">
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
              Behavioral Map · v1
            </span>
          </div>
          <h1
            className="text-[19px] font-semibold leading-tight"
            style={{ color: 'var(--text-h)', letterSpacing: '-0.01em' }}
          >
            Roaring Fork Valley
            <br />
            Commute Flows
          </h1>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            2023 LEHD OnTheMap · 11 workplace anchors · ~45,800 workers
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
              directionFilter={directionFilter}
              zips={zips}
              selectedZip={selectedZip}
              mode={mode}
              onReset={() => onSelectZip(null)}
            />
          ) : (
            <StatsAggregated
              flows={flows}
              directionFilteredFlows={directionFilteredFlows}
              directionFilter={directionFilter}
              mode={mode}
              topCorridor={topCorridor}
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
            2023
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
