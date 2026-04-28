// Selected-ZIP stat layout — top-10 ranked horizontal bar list with explicit
// within-ZIP and residual rows so the section accounts for 100% of workers.
// Headline total excludes within-ZIP traffic (commute-from-elsewhere only).
//
// When a direction filter is active, the top-10 list and headline cross-ZIP
// total re-aggregate against the filtered set. The within-ZIP row, the
// All Other Locations row, and the "total workforce / residents" sub-line
// stay pinned to the unfiltered detail because direction is not meaningful
// for self-flows or the off-map residual, and the anchor's universe is fixed.

import type { DirectionFilter, FlowRow, Mode, ZipMeta } from '../types/flow';
import { detailForZip } from '../lib/flowQueries';
import { fmtInt, fmtPct } from '../lib/format';

interface Props {
  flows: FlowRow[];
  directionFilteredFlows: FlowRow[];
  directionFilter: DirectionFilter;
  zips: ZipMeta[];
  selectedZip: string;
  mode: Mode;
  onReset: () => void;
}

export function StatsForZip({
  flows,
  directionFilteredFlows,
  directionFilter,
  zips,
  selectedZip,
  mode,
  onReset,
}: Props) {
  const meta = zips.find((z) => z.zip === selectedZip);
  if (!meta) return null;

  // Two details: filtered for top-N flows + headline; unfiltered for self,
  // ALL_OTHER, the anchor universe denominator, and the chip denominator.
  const detail = detailForZip(directionFilteredFlows, meta, mode);
  const unfilteredDetail = detailForZip(flows, meta, mode);

  // Roll up rows that share a place name (e.g., Eagle 81631 + 81637, Grand
  // Junction 81501 + 81505) into a single line so the top-10 reflects city-
  // level rank rather than splitting cities across multi-ZIP cuts.
  type AggRow = { place: string; zips: string[]; workerCount: number };
  const aggregatedFlows: AggRow[] = (() => {
    const map = new Map<string, AggRow>();
    for (const f of detail.flows) {
      const place = mode === 'inbound' ? f.originPlace : f.destPlace;
      const zip = mode === 'inbound' ? f.originZip : f.destZip;
      const existing = map.get(place);
      if (existing) {
        existing.workerCount += f.workerCount;
        if (!existing.zips.includes(zip)) existing.zips.push(zip);
      } else {
        map.set(place, { place, zips: [zip], workerCount: f.workerCount });
      }
    }
    const rows = Array.from(map.values());
    for (const r of rows) r.zips.sort();
    rows.sort((a, b) => b.workerCount - a.workerCount);
    return rows;
  })();
  const top10 = aggregatedFlows.slice(0, 10);

  // Self and ALL_OTHER pinned to unfiltered.
  const selfFlow = unfilteredDetail.selfFlow;
  const allOther = unfilteredDetail.allOther;
  // Remainder = aggregated top-N+ tail + unfiltered ALL_OTHER (always preserved).
  const remainderCount =
    aggregatedFlows.slice(10).reduce((acc, r) => acc + r.workerCount, 0) + allOther;

  // Headline cross-ZIP total. When filter is 'all', this equals the original
  // detail.total - selfFlow (cross-zip + ALL_OTHER). When filter is active,
  // detail.allOther is 0 (filtered out), so the same formula yields the
  // filtered cross-ZIP sum — exactly what should display.
  const headlineTotal = detail.total - detail.selfFlow;

  // Anchor universe — stays fixed regardless of filter so percentages stay
  // comparable to the ZIP's full workforce / resident base.
  const anchorTotal = unfilteredDetail.total;

  // Bars scale against the largest single row visible (any of top-10, self,
  // or remainder) so the visual ranking stays honest across all 12 rows.
  const maxCount = Math.max(
    1,
    ...top10.map((r) => r.workerCount),
    selfFlow,
    remainderCount,
  );

  const directionLabel =
    mode === 'inbound' ? 'workers commute INTO' : 'residents commute OUT to other valley ZIPs';
  const subjectLabel =
    mode === 'inbound' ? meta.place : `${meta.place} residents`;

  const filterActive = directionFilter !== 'all';
  const filterLabel = directionFilter === 'east' ? 'Eastbound only' : 'Westbound only';
  // Chip math is scoped to the selected ZIP and excludes self + ALL_OTHER —
  // both are direction-neutral by definition.
  const chipNumerator = detail.flows.length;
  const chipDenominator = unfilteredDetail.flows.length;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-base font-semibold" style={{ color: 'var(--text-h)' }}>
            {meta.place}
          </div>
          <div className="text-[11px] tnum" style={{ color: 'var(--text-dim)' }}>
            ZIP {meta.zip}
          </div>
        </div>
        <button
          onClick={onReset}
          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded-md transition-colors"
          style={{
            color: 'var(--text-dim)',
            border: '1px solid var(--panel-border)',
          }}
        >
          Reset
        </button>
      </div>

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
            Filtered: {filterLabel} · {fmtInt(chipNumerator)} of {fmtInt(chipDenominator)} flows shown
          </span>
        </div>
      )}

      <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
          {mode === 'inbound' ? 'Total Inbound Workers' : 'Total Outbound Workers'}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-xl font-semibold tnum" style={{ color: 'var(--text-h)' }}>
            {fmtInt(headlineTotal)}
          </span>
          <span className="text-[11px] tnum" style={{ color: 'var(--text-dim)' }}>
            {fmtPct(headlineTotal / Math.max(1, anchorTotal))}{' '}
            of {mode === 'inbound' ? 'workforce' : 'residents'}
          </span>
        </div>
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {fmtInt(headlineTotal)} {directionLabel} {mode === 'inbound' ? meta.place : ''}
        </div>
        <div className="mt-1.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {mode === 'inbound' ? 'Total workforce' : 'Total resident workers'}{' '}
          <span className="tnum" style={{ color: 'var(--text-h)' }}>
            {fmtInt(anchorTotal)}
          </span>{' '}
          {mode === 'inbound'
            ? `workers in ${meta.place}`
            : `residents of ${meta.place}`}
        </div>
      </div>

      <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--text-dim)' }}>
          {mode === 'inbound' ? `Top 10 origin ZIPs sending to ${meta.place}` : `Top 10 destinations of ${subjectLabel}`}
        </div>
        <ul className="space-y-1.5">
          {top10.map((r) => {
            const share = r.workerCount / Math.max(1, anchorTotal);
            const barW = (r.workerCount / maxCount) * 100;
            return (
              <li key={r.place} className="text-xs">
                <div className="flex justify-between mb-0.5">
                  <span style={{ color: 'var(--text-h)' }}>
                    {r.place} <span className="tnum" style={{ color: 'var(--text-dim)' }}>· {r.zips.join(', ')}</span>
                  </span>
                  <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                    {fmtInt(r.workerCount)} · {fmtPct(share)}
                  </span>
                </div>
                <div className="h-[3px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <div
                    className="h-full"
                    style={{
                      width: `${barW}%`,
                      background: 'var(--accent)',
                      opacity: 0.8,
                    }}
                  />
                </div>
              </li>
            );
          })}
          {selfFlow > 0 && (
            <li className="text-xs">
              <div className="flex justify-between mb-0.5">
                <span style={{ color: 'var(--text-h)' }}>
                  Within-ZIP commute{' '}
                  <span className="tnum" style={{ color: 'var(--text-dim)' }}>· {meta.zip}</span>
                </span>
                <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                  {fmtInt(selfFlow)} · {fmtPct(selfFlow / Math.max(1, anchorTotal))}
                </span>
              </div>
              <div className="h-[3px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <div
                  className="h-full"
                  style={{
                    width: `${(selfFlow / maxCount) * 100}%`,
                    background: 'rgba(200,205,215,0.55)',
                  }}
                />
              </div>
            </li>
          )}
          {remainderCount > 0 && (
            <li className="text-xs">
              <div className="flex justify-between mb-0.5">
                <span style={{ color: 'var(--text-h)' }}>
                  {mode === 'inbound' ? 'All Other Locations' : 'Other destinations'}
                  {filterActive && allOther > 0 && (
                    <span className="ml-1 italic" style={{ color: 'var(--text-dim)' }}>
                      · direction filter does not apply
                    </span>
                  )}
                </span>
                <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                  {fmtInt(remainderCount)} · {fmtPct(remainderCount / Math.max(1, anchorTotal))}
                </span>
              </div>
              <div className="h-[3px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <div
                  className="h-full"
                  style={{
                    width: `${(remainderCount / maxCount) * 100}%`,
                    background: 'rgba(200,205,215,0.55)',
                  }}
                />
              </div>
            </li>
          )}
          {top10.length === 0 && selfFlow === 0 && remainderCount === 0 && (
            <li className="text-xs italic" style={{ color: 'var(--text-dim)' }}>
              No cross-ZIP flows in this direction.
            </li>
          )}
        </ul>
      </div>

    </div>
  );
}
