// Aggregated-state stat tiles — shown when no ZIP is selected. Reads only the
// active mode's dataset; mode-exclusivity is enforced by the caller.
//
// When a direction filter is active, totals/top-corridor stats re-aggregate
// against the filtered set. The All Other Locations share remains pinned to
// the unfiltered dataset because direction is not meaningful for the off-map
// residual. A status chip surfaces the active filter and the count of flows
// shown vs. the unfiltered cross-ZIP baseline.

import type { DirectionFilter, FlowRow, Mode } from '../types/flow';
import { computeAggregated } from '../lib/flowQueries';
import { fmtInt, fmtPct } from '../lib/format';

interface Props {
  flows: FlowRow[];
  directionFilteredFlows: FlowRow[];
  directionFilter: DirectionFilter;
  mode: Mode;
  // Heaviest corridor edge in the active mode + direction filter, derived
  // from the corridor-graph aggregation the map renders. The dashboard
  // number matches the thickest line on the canvas.
  topCorridor: { label: string; total: number } | null;
}

function StatRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="py-2.5 border-b last:border-0" style={{ borderColor: 'var(--rule)' }}>
      <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-xl font-semibold tnum" style={{ color: 'var(--text-h)' }}>
          {value}
        </div>
        {sub && (
          <div className="text-xs tnum" style={{ color: 'var(--text-dim)' }}>{sub}</div>
        )}
      </div>
    </div>
  );
}

// Count of cross-ZIP, non-ALL_OTHER flows — the chip's meaningful unit.
function crossZipFlowCount(flows: FlowRow[]): number {
  let n = 0;
  for (const f of flows) {
    if (f.originZip === f.destZip) continue;
    if (f.originZip === 'ALL_OTHER' || f.destZip === 'ALL_OTHER') continue;
    n += 1;
  }
  return n;
}

export function StatsAggregated({
  flows,
  directionFilteredFlows,
  directionFilter,
  mode,
  topCorridor,
}: Props) {
  // Headline numbers respect the direction filter.
  const summary = computeAggregated(directionFilteredFlows);
  // ALL_OTHER share is always read from the unfiltered set — direction is
  // not meaningful for the non-spatial residual.
  const unfiltered = computeAggregated(flows);

  const totalLabel =
    mode === 'inbound' ? 'Total inbound workers' : 'Total resident workers';
  const totalSub =
    mode === 'inbound' ? 'into the 11 workplace anchors' : 'sent from residence ZIPs';

  const filterActive = directionFilter !== 'all';
  const filterLabel = directionFilter === 'east' ? 'Eastbound only' : 'Westbound only';
  const numerator = crossZipFlowCount(directionFilteredFlows);
  const denominator = crossZipFlowCount(flows);

  return (
    <div>
      {filterActive && (
        <div
          className="mb-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px]"
          style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            border: '1px solid var(--panel-border)',
          }}
          role="status"
        >
          <span
            className="inline-block w-1 h-1 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
          <span className="tnum">
            Filtered: {filterLabel} · {fmtInt(numerator)} of {fmtInt(denominator)} flows shown
          </span>
        </div>
      )}
      <StatRow label={totalLabel} value={fmtInt(summary.totalWorkers)} sub={totalSub} />
      <StatRow
        label="Cross-ZIP commute share"
        value={fmtPct(summary.crossZipShare)}
        sub={mode === 'inbound' ? 'of mapped workforce' : 'of mapped residents'}
      />
      {topCorridor && (
        <StatRow
          label="Top corridor"
          value={fmtInt(topCorridor.total)}
          sub={topCorridor.label}
        />
      )}
      {summary.topOutbound && (
        <StatRow
          label="Top Origin - Destination Pair"
          value={fmtInt(summary.topOutbound.workerCount)}
          sub={`${summary.topOutbound.originPlace} → ${summary.topOutbound.destPlace}`}
        />
      )}
      <StatRow
        label="All Other Locations share"
        value={fmtPct(unfiltered.allOtherShare)}
        sub={
          filterActive
            ? 'non-spatial residual · direction filter does not apply'
            : 'non-spatial residual'
        }
      />
    </div>
  );
}
