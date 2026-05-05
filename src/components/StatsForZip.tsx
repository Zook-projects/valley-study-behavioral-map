// Selected-ZIP stat layout — top-10 ranked horizontal bar list with explicit
// within-ZIP and residual rows so the section accounts for 100% of workers.
// Headline total excludes within-ZIP traffic (commute-from-elsewhere only).
//
// When a direction filter is active, the top-10 list and headline cross-ZIP
// total re-aggregate against the filtered set. The within-ZIP row, the
// All Other Locations row, and the "total workforce / residents" sub-line
// stay pinned to the unfiltered detail because direction is not meaningful
// for self-flows or the off-map residual, and the anchor's universe is fixed.

import type { ReactNode } from 'react';
import type { DirectionFilter, FlowRow, Mode, ZipMeta } from '../types/flow';
import { detailForZip } from '../lib/flowQueries';
import { fmtInt, fmtPct } from '../lib/format';

interface Props {
  flows: FlowRow[];
  directionFilteredFlows: FlowRow[];
  // Inbound dataset — needed by the "Total Workforce" tile so the jobs-
  // located-in-ZIP figure is available regardless of the active mode.
  flowsInbound: FlowRow[];
  // Outbound dataset and direction-filtered variants — used by the dual
  // Top inflow / Top outflow lists rendered in the anchor branch so both
  // directions render simultaneously regardless of the active mode.
  flowsOutbound?: FlowRow[];
  directionFilteredInbound?: FlowRow[];
  directionFilteredOutbound?: FlowRow[];
  directionFilter: DirectionFilter;
  zips: ZipMeta[];
  selectedZip: string;
  // Selection class — when 'non-anchor', the panel pivots on origin (the
  // searched residence ZIP/place) and shows its workers' anchor destinations.
  selectionKind: 'aggregate' | 'anchor' | 'non-anchor';
  // Set when selectionKind === 'non-anchor'. Carries the place name and
  // every ZIP that shares it.
  nonAnchorBundle: { place: string; zips: string[] } | null;
  // Map-facing visible flows — for non-anchor this is the aggregate inbound
  // network (so the map shows full context). Stats panels read `bundleFlows`
  // for the non-anchor pivot instead.
  visibleFlows: FlowRow[];
  // Origin-pivot rows for the non-anchor selection (one row per anchor
  // destination, aggregated across the bundle's ZIPs). Empty for anchor /
  // aggregate views.
  bundleFlows: FlowRow[];
  mode: Mode;
  // Optional secondary partner selection — a row from the top-N list. When
  // set, the headline tiles scope to the partner→anchor (inbound) or
  // anchor→partner (outbound) flow. Null = no partner selected.
  selectedPartner: { place: string; zips: string[] } | null;
  onSelectPartner: (p: { place: string; zips: string[] } | null) => void;
  onReset: () => void;
  // Optional layout slot. When 'tiles' the component renders only the
  // header + Total Inbound + Total Workforce tiles. When 'lists' it renders
  // only the dual Top inflow / Top outflow lists. When undefined (default)
  // it renders the full stack — used by CommuteView / DashboardTile.
  slot?: 'tiles' | 'lists';
}

export function StatsForZip({
  flows,
  directionFilteredFlows,
  flowsInbound,
  flowsOutbound,
  directionFilteredInbound,
  directionFilteredOutbound,
  directionFilter,
  zips,
  selectedZip,
  selectionKind,
  nonAnchorBundle,
  bundleFlows,
  mode,
  selectedPartner,
  onSelectPartner,
  onReset,
  slot,
}: Props) {
  const meta = zips.find((z) => z.zip === selectedZip);
  if (!meta) return null;

  // Non-anchor branch — the searched ZIP isn't a workplace anchor, so the
  // panel pivots on origin and shows where this place's residents work
  // among the 11 anchors. The headline, top-N, and residual row come
  // straight from `visibleFlows` (already aggregated upstream); we don't
  // render the Total Workforce tile or within-ZIP row here because non-
  // anchor ZIPs aren't in the LODES anchor universe.
  if (selectionKind === 'non-anchor' && nonAnchorBundle) {
    return (
      <NonAnchorStats
        bundle={nonAnchorBundle}
        visibleFlows={bundleFlows}
        selectedPartner={selectedPartner}
        onSelectPartner={onSelectPartner}
        onReset={onReset}
      />
    );
  }

  // Two details: filtered for top-N flows + headline; unfiltered for self,
  // ALL_OTHER, the anchor universe denominator, and the chip denominator.
  const detail = detailForZip(directionFilteredFlows, meta, mode);
  const unfilteredDetail = detailForZip(flows, meta, mode);

  // Roll up rows that share a place name (e.g., Eagle 81631 + 81637, Grand
  // Junction 81501 + 81505) into a single line so the top-10 reflects city-
  // level rank rather than splitting cities across multi-ZIP cuts.
  // Flows without a known place name (external CO ZCTAs not in the seed
  // metadata) are NOT aggregated by place — they collapse into the residual
  // bucket alongside the off-map ALL_OTHER, so they don't crowd the top-10
  // as either a wall of individual rows or one mega-row of comma-joined ZIPs.
  type AggRow = { place: string; zips: string[]; workerCount: number };
  const aggregatedFlows: AggRow[] = (() => {
    const map = new Map<string, AggRow>();
    for (const f of detail.flows) {
      const place = mode === 'inbound' ? f.originPlace : f.destPlace;
      const zip = mode === 'inbound' ? f.originZip : f.destZip;
      if (!place) continue;
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

  // Same bucketing applied against the unfiltered detail so the residual
  // row stays direction-neutral (it always includes external CO ZCTAs from
  // the full universe, not just the filtered slice).
  let unfilteredUnknownPlaceCount = 0;
  for (const f of unfilteredDetail.flows) {
    const place = mode === 'inbound' ? f.originPlace : f.destPlace;
    if (!place) unfilteredUnknownPlaceCount += f.workerCount;
  }

  // Self and ALL_OTHER pinned to unfiltered.
  const selfFlow = unfilteredDetail.selfFlow;
  const allOther = unfilteredDetail.allOther;
  // Remainder = aggregated top-N+ tail + unknown-place external CO ZCTAs +
  // unfiltered ALL_OTHER (always preserved). The unknown-place portion uses
  // the unfiltered count so the residual stays direction-neutral.
  const remainderCount =
    aggregatedFlows.slice(10).reduce((acc, r) => acc + r.workerCount, 0) +
    unfilteredUnknownPlaceCount +
    allOther;

  // Headline cross-ZIP total. When filter is 'all', this equals the original
  // detail.total - selfFlow (cross-zip + ALL_OTHER). When filter is active,
  // detail.allOther is 0 (filtered out), so the same formula yields the
  // filtered cross-ZIP sum — exactly what should display.
  const headlineTotal = detail.total - detail.selfFlow;

  // Anchor universe — stays fixed regardless of filter so percentages stay
  // comparable to the ZIP's full workforce / resident base.
  const anchorTotal = unfilteredDetail.total;

  // "Total Workforce" tile facts — pinned to unfiltered datasets since they
  // describe the ZIP's standing universe, not a filtered slice.
  // workforce   = jobs located in the ZIP                → inbound total for the ZIP
  // liveAndWork = people whose origin AND destination ZIP is this ZIP — the
  //               within-ZIP self-flow. Already exposed by unfilteredDetail
  //               (its selfFlow field), and identical whether read from the
  //               inbound or outbound side.
  const workforce = detailForZip(flowsInbound, meta, 'inbound').total;
  const liveAndWork = unfilteredDetail.selfFlow;

  // Partner-scoped flow value — workers in the single partner→anchor (inbound)
  // or anchor→partner (outbound) flow. Sums across multi-ZIP cities like
  // Eagle (81631 + 81637) so the figure matches the row clicked in the list.
  const partnerSet = selectedPartner ? new Set(selectedPartner.zips) : null;
  const partnerWorkers = partnerSet
    ? unfilteredDetail.flows.reduce((acc, f) => {
        const partnerSide = mode === 'inbound' ? f.originZip : f.destZip;
        return partnerSet.has(partnerSide) ? acc + f.workerCount : acc;
      }, 0)
    : 0;

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

  const showTiles = slot !== 'lists';
  const showLists = slot !== 'tiles';

  return (
    <div>
      {showTiles && (
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
      )}

      {/* Total Workforce — place-fact tile. Both numbers are properties of
          the ZIP itself (jobs located here vs employed residents), so the
          tile renders the same content regardless of the active mode. When a
          partner is selected, the headline scopes to the partner contribution
          to that workforce so it stays parallel to "Total Inbound Workers"
          below. The live-and-work sub-line stays anchor-pinned because it's a
          property of the ZIP itself, not of any partner pair. */}
      {showTiles ? (
      <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
          Total Workforce
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-xl font-semibold tnum" style={{ color: 'var(--text-h)' }}>
            {fmtInt(selectedPartner ? partnerWorkers : workforce)}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {selectedPartner
              ? `from ${selectedPartner.place} (${fmtPct(partnerWorkers / Math.max(1, workforce))} of ${meta.place} workforce)`
              : `workers employed in ${meta.place}`}
          </span>
        </div>
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
          <span className="tnum" style={{ color: 'var(--text-h)' }}>
            {fmtInt(liveAndWork)}
          </span>{' '}
          people live and work in {meta.place}
        </div>
      </div>
      ) : null}

      {showTiles ? (
      <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
          {mode === 'inbound' ? 'Total Inbound Workers' : 'Total Outbound Workers'}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-xl font-semibold tnum" style={{ color: 'var(--text-h)' }}>
            {fmtInt(selectedPartner ? partnerWorkers : headlineTotal)}
          </span>
          <span className="text-[11px] tnum" style={{ color: 'var(--text-dim)' }}>
            {selectedPartner ? (
              <>
                {fmtPct(partnerWorkers / Math.max(1, headlineTotal))} of commuters
              </>
            ) : (
              <>
                {fmtPct(headlineTotal / Math.max(1, anchorTotal))} of{' '}
                {mode === 'inbound' ? 'workforce' : 'residents'}
              </>
            )}
          </span>
        </div>
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {selectedPartner
            ? mode === 'inbound'
              ? `${fmtInt(partnerWorkers)} workers commute from ${selectedPartner.place} into ${meta.place}`
              : `${fmtInt(partnerWorkers)} ${meta.place} residents commute to ${selectedPartner.place}`
            : `${fmtInt(headlineTotal)} ${directionLabel} ${mode === 'inbound' ? meta.place : ''}`}
        </div>
      </div>
      ) : null}

      {showLists && (() => {
        // Dashboard view passes the full set of inbound + outbound flow
        // datasets so we can render Top inflow and Top outflow as parallel
        // lists. When those props are absent (CommuteView / DashboardTile),
        // fall back to the original single, mode-driven list.
        const useDualList =
          flowsOutbound != null &&
          directionFilteredInbound != null &&
          directionFilteredOutbound != null;

        if (useDualList) {
          const inflowData = buildTopNData(
            directionFilteredInbound!,
            flowsInbound,
            meta,
            'inbound',
          );
          const outflowData = buildTopNData(
            directionFilteredOutbound!,
            flowsOutbound!,
            meta,
            'outbound',
          );

          return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
              <TopNList
                title={`Top inflow into ${meta.place}`}
                data={inflowData}
                meta={meta}
                residualLabel="All Other Locations"
                emptyMessage="No cross-ZIP flows in this direction."
                filterActive={filterActive}
                selectedPartner={selectedPartner}
                onSelectPartner={onSelectPartner}
              />
              <TopNList
                title={`Top outflow from ${meta.place}`}
                data={outflowData}
                meta={meta}
                residualLabel="Other destinations"
                emptyMessage="No cross-ZIP flows in this direction."
                filterActive={filterActive}
                selectedPartner={null}
                onSelectPartner={null}
              />
            </div>
          );
        }

        return (
          <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
            <div className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--text-dim)' }}>
              {mode === 'inbound' ? `Top 10 origin ZIPs sending to ${meta.place}` : `Top 10 destinations of ${subjectLabel}`}
            </div>
            <ul className="space-y-1.5">
              {top10.map((r) => {
                const share = r.workerCount / Math.max(1, anchorTotal);
                const barW = (r.workerCount / maxCount) * 100;
                const isSelected = selectedPartner?.place === r.place;
                const isOtherSelected = selectedPartner != null && !isSelected;
                return (
                  <li key={r.place} className="text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        onSelectPartner(
                          isSelected ? null : { place: r.place, zips: r.zips },
                        )
                      }
                      aria-pressed={isSelected}
                      className="w-full text-left rounded-md px-1.5 py-1 transition-colors"
                      style={{
                        background: isSelected
                          ? 'var(--accent-soft)'
                          : 'transparent',
                        border: `1px solid ${isSelected ? 'var(--accent)' : 'transparent'}`,
                        opacity: isOtherSelected ? 0.45 : 1,
                        cursor: 'pointer',
                      }}
                    >
                      <div className="flex justify-between mb-0.5">
                        <span style={{ color: isSelected ? 'var(--accent)' : 'var(--text-h)' }}>
                          {r.place} <span className="tnum" style={{ color: 'var(--text-dim)' }}>· {r.zips.length > 1 ? 'multiple' : r.zips[0]}</span>
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
                            opacity: isSelected ? 1 : 0.8,
                          }}
                        />
                      </div>
                    </button>
                  </li>
                );
              })}
              {selfFlow > 0 && (() => {
                // The within-ZIP commute row behaves like a top-10 partner row,
                // but the partner is the anchor's own ZIP — clicking it scopes
                // visualizations to the self-flow only (live-and-work cohort).
                const isSelected =
                  selectedPartner != null &&
                  selectedPartner.zips.length === 1 &&
                  selectedPartner.zips[0] === meta.zip;
                const isOtherSelected = selectedPartner != null && !isSelected;
                return (
                  <li className="text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        onSelectPartner(
                          isSelected ? null : { place: meta.place, zips: [meta.zip] },
                        )
                      }
                      aria-pressed={isSelected}
                      className="w-full text-left rounded-md px-1.5 py-1 transition-colors"
                      style={{
                        background: isSelected
                          ? 'var(--accent-soft)'
                          : 'transparent',
                        border: `1px solid ${isSelected ? 'var(--accent)' : 'transparent'}`,
                        opacity: isOtherSelected ? 0.45 : 1,
                        cursor: 'pointer',
                      }}
                    >
                      <div className="flex justify-between mb-0.5">
                        <span style={{ color: isSelected ? 'var(--accent)' : 'var(--text-h)' }}>
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
                            background: isSelected ? 'var(--accent)' : 'rgba(200,205,215,0.55)',
                            opacity: isSelected ? 1 : 0.8,
                          }}
                        />
                      </div>
                    </button>
                  </li>
                );
              })()}
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
        );
      })()}

    </div>
  );
}

// -----------------------------------------------------------------------------
// Dual Top inflow / Top outflow lists for the Dashboard view's anchor pane.
// `TopNList` mirrors the single-list visual style but takes precomputed data
// so the same component can render either direction. Inflow passes a real
// `onSelectPartner`; outflow passes null and the rows render as inert divs
// (matching the BottomCardStrip's display-only Top inflow/Top outflow Cards).
// -----------------------------------------------------------------------------
type TopNData = {
  top10: { place: string; zips: string[]; workerCount: number }[];
  selfFlow: number;
  allOther: number;
  remainder: number;
  total: number;
  maxCount: number;
};

function buildTopNData(
  filteredFlows: FlowRow[],
  rawFlows: FlowRow[],
  meta: ZipMeta,
  direction: Mode,
): TopNData {
  const detail = detailForZip(filteredFlows, meta, direction);
  const unfilteredDetail = detailForZip(rawFlows, meta, direction);

  type AggRow = { place: string; zips: string[]; workerCount: number };
  const map = new Map<string, AggRow>();
  for (const f of detail.flows) {
    const place = direction === 'inbound' ? f.originPlace : f.destPlace;
    const zip = direction === 'inbound' ? f.originZip : f.destZip;
    if (!place) continue;
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
  const TOP_N = 15;
  const top10 = rows.slice(0, TOP_N);

  let unknownPlaceCount = 0;
  for (const f of unfilteredDetail.flows) {
    const place = direction === 'inbound' ? f.originPlace : f.destPlace;
    if (!place) unknownPlaceCount += f.workerCount;
  }

  const selfFlow = unfilteredDetail.selfFlow;
  const allOther = unfilteredDetail.allOther;
  const remainder =
    rows.slice(TOP_N).reduce((acc, r) => acc + r.workerCount, 0) +
    unknownPlaceCount +
    allOther;
  const total = unfilteredDetail.total;
  const maxCount = Math.max(
    1,
    ...top10.map((r) => r.workerCount),
    selfFlow,
    remainder,
  );
  return { top10, selfFlow, allOther, remainder, total, maxCount };
}

interface TopNListProps {
  title: string;
  data: TopNData;
  meta: ZipMeta;
  residualLabel: string;
  emptyMessage: string;
  filterActive: boolean;
  selectedPartner: { place: string; zips: string[] } | null;
  // Null = display-only mode (no click-to-select-partner). The outflow list
  // passes null; the inflow list passes the real handler so it preserves
  // the original top-10's filter behavior.
  onSelectPartner:
    | ((p: { place: string; zips: string[] } | null) => void)
    | null;
}

function TopNList({
  title,
  data,
  meta,
  residualLabel,
  emptyMessage,
  filterActive,
  selectedPartner,
  onSelectPartner,
}: TopNListProps) {
  const { top10, selfFlow, allOther, remainder, total, maxCount } = data;
  const clickable = onSelectPartner != null;
  const denom = Math.max(1, total);

  const renderRow = (
    key: string,
    label: ReactNode,
    workerCount: number,
    barColor: string,
    options?: {
      onClick?: () => void;
      selected?: boolean;
      otherSelected?: boolean;
    },
  ) => {
    const share = workerCount / denom;
    const barW = (workerCount / maxCount) * 100;
    const selected = options?.selected ?? false;
    const otherSelected = options?.otherSelected ?? false;
    const handleClick = options?.onClick;
    const isButton = handleClick != null;
    const inner = (
      <>
        <div className="flex justify-between mb-0.5">
          <span style={{ color: selected ? 'var(--accent)' : 'var(--text-h)' }}>
            {label}
          </span>
          <span className="tnum" style={{ color: 'var(--text-dim)' }}>
            {fmtInt(workerCount)} · {fmtPct(share)}
          </span>
        </div>
        <div className="h-[3px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <div
            className="h-full"
            style={{
              width: `${barW}%`,
              background: selected ? 'var(--accent)' : barColor,
              opacity: selected ? 1 : 0.8,
            }}
          />
        </div>
      </>
    );

    if (isButton) {
      return (
        <li key={key} className="text-xs">
          <button
            type="button"
            onClick={handleClick}
            aria-pressed={selected}
            className="w-full text-left rounded-md px-1.5 py-1 transition-colors"
            style={{
              background: selected ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${selected ? 'var(--accent)' : 'transparent'}`,
              opacity: otherSelected ? 0.45 : 1,
              cursor: 'pointer',
            }}
          >
            {inner}
          </button>
        </li>
      );
    }
    return (
      <li key={key} className="text-xs px-1.5 py-1">
        {inner}
      </li>
    );
  };

  return (
    <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
      <div className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--text-dim)' }}>
        {title}
      </div>
      <ul className="space-y-1.5">
        {top10.map((r) => {
          const isSelected = clickable && selectedPartner?.place === r.place;
          const isOtherSelected =
            clickable && selectedPartner != null && !isSelected;
          return renderRow(
            r.place,
            <>
              {r.place}{' '}
              <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                · {r.zips.length > 1 ? 'multiple' : r.zips[0]}
              </span>
            </>,
            r.workerCount,
            'var(--accent)',
            clickable
              ? {
                  onClick: () =>
                    onSelectPartner!(
                      isSelected ? null : { place: r.place, zips: r.zips },
                    ),
                  selected: isSelected,
                  otherSelected: isOtherSelected,
                }
              : undefined,
          );
        })}
        {selfFlow > 0 &&
          (() => {
            const isSelected =
              clickable &&
              selectedPartner != null &&
              selectedPartner.zips.length === 1 &&
              selectedPartner.zips[0] === meta.zip;
            const isOtherSelected =
              clickable && selectedPartner != null && !isSelected;
            return renderRow(
              `__self__${meta.zip}`,
              <>
                Within-ZIP commute{' '}
                <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                  · {meta.zip}
                </span>
              </>,
              selfFlow,
              'rgba(200,205,215,0.55)',
              clickable
                ? {
                    onClick: () =>
                      onSelectPartner!(
                        isSelected
                          ? null
                          : { place: meta.place, zips: [meta.zip] },
                      ),
                    selected: isSelected,
                    otherSelected: isOtherSelected,
                  }
                : undefined,
            );
          })()}
        {remainder > 0 && (
          <li className="text-xs px-1.5 py-1">
            <div className="flex justify-between mb-0.5">
              <span style={{ color: 'var(--text-h)' }}>
                {residualLabel}
                {filterActive && allOther > 0 && (
                  <span className="ml-1 italic" style={{ color: 'var(--text-dim)' }}>
                    · direction filter does not apply
                  </span>
                )}
              </span>
              <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                {fmtInt(remainder)} · {fmtPct(remainder / denom)}
              </span>
            </div>
            <div className="h-[3px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div
                className="h-full"
                style={{
                  width: `${(remainder / maxCount) * 100}%`,
                  background: 'rgba(200,205,215,0.55)',
                }}
              />
            </div>
          </li>
        )}
        {top10.length === 0 && selfFlow === 0 && remainder === 0 && (
          <li className="text-xs italic" style={{ color: 'var(--text-dim)' }}>
            {emptyMessage}
          </li>
        )}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Non-anchor stats panel — rendered when the searched place is a residential
// ZIP (or multi-ZIP place) outside the 11 workplace anchors. Layout mirrors
// the anchor StatsForZip (headline + top-N) but:
//   - No "Total Workforce" tile (non-anchor ZIPs aren't in the LODES anchor
//     workplace universe).
//   - No within-ZIP commute row (non-anchor → anchor is always cross-ZIP by
//     construction).
//   - Top-N rolls up by destination anchor place. Cities split across multiple
//     anchor ZIPs (e.g. Aspen 81611+81612) collapse into one row.
//   - Residual row = "All other anchor workplaces" only when the top-10
//     truncation drops something.
// -----------------------------------------------------------------------------
interface NonAnchorStatsProps {
  bundle: { place: string; zips: string[] };
  visibleFlows: FlowRow[];
  selectedPartner: { place: string; zips: string[] } | null;
  onSelectPartner: (p: { place: string; zips: string[] } | null) => void;
  onReset: () => void;
}

function NonAnchorStats({
  bundle,
  visibleFlows,
  selectedPartner,
  onSelectPartner,
  onReset,
}: NonAnchorStatsProps) {
  // Aggregate by destination place (anchor cities like Aspen span 81611 +
  // 81612; we want them to read as one row).
  type AggRow = { place: string; zips: string[]; workerCount: number };
  const aggregatedFlows: AggRow[] = (() => {
    const map = new Map<string, AggRow>();
    for (const f of visibleFlows) {
      const place = f.destPlace;
      if (!place) continue;
      const existing = map.get(place);
      if (existing) {
        existing.workerCount += f.workerCount;
        if (!existing.zips.includes(f.destZip)) existing.zips.push(f.destZip);
      } else {
        map.set(place, { place, zips: [f.destZip], workerCount: f.workerCount });
      }
    }
    const rows = Array.from(map.values());
    for (const r of rows) r.zips.sort();
    rows.sort((a, b) => b.workerCount - a.workerCount);
    return rows;
  })();
  const top10 = aggregatedFlows.slice(0, 10);
  const remainderCount = aggregatedFlows
    .slice(10)
    .reduce((acc, r) => acc + r.workerCount, 0);
  const headlineTotal = aggregatedFlows.reduce(
    (acc, r) => acc + r.workerCount,
    0,
  );

  // Partner-scoped flow value — workers in the single partner→bundle pair.
  const partnerSet = selectedPartner ? new Set(selectedPartner.zips) : null;
  const partnerWorkers = partnerSet
    ? visibleFlows.reduce(
        (acc, f) => (partnerSet.has(f.destZip) ? acc + f.workerCount : acc),
        0,
      )
    : 0;

  const maxCount = Math.max(
    1,
    ...top10.map((r) => r.workerCount),
    remainderCount,
  );

  const zipLabel =
    bundle.zips.length === 1 ? bundle.zips[0] : `${bundle.zips.length} ZIPs`;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-base font-semibold" style={{ color: 'var(--text-h)' }}>
            {bundle.place}
          </div>
          <div className="text-[11px] tnum" style={{ color: 'var(--text-dim)' }}>
            {bundle.zips.length === 1
              ? `ZIP ${bundle.zips[0]}`
              : `ZIPs ${bundle.zips.join(' · ')}`}
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

      <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div
          className="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          Inbound Workers to Anchor Workplaces
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span
            className="text-xl font-semibold tnum"
            style={{ color: 'var(--text-h)' }}
          >
            {fmtInt(selectedPartner ? partnerWorkers : headlineTotal)}
          </span>
          <span className="text-[11px] tnum" style={{ color: 'var(--text-dim)' }}>
            {selectedPartner
              ? `${fmtPct(partnerWorkers / Math.max(1, headlineTotal))} of ${bundle.place} → anchor commuters`
              : `${bundle.place} residents employed at anchors`}
          </span>
        </div>
        <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {selectedPartner
            ? `${fmtInt(partnerWorkers)} ${bundle.place} residents commute to ${selectedPartner.place}`
            : `${fmtInt(headlineTotal)} ${bundle.place} residents (${zipLabel}) commute to one of the 11 workplace anchors`}
        </div>
      </div>

      <div className="py-2.5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div
          className="text-[10px] font-medium uppercase tracking-wider mb-2"
          style={{ color: 'var(--text-dim)' }}
        >
          Top anchor destinations of {bundle.place} residents
        </div>
        <ul className="space-y-1.5">
          {top10.map((r) => {
            const share = r.workerCount / Math.max(1, headlineTotal);
            const barW = (r.workerCount / maxCount) * 100;
            const isSelected = selectedPartner?.place === r.place;
            const isOtherSelected = selectedPartner != null && !isSelected;
            return (
              <li key={r.place} className="text-xs">
                <button
                  type="button"
                  onClick={() =>
                    onSelectPartner(
                      isSelected ? null : { place: r.place, zips: r.zips },
                    )
                  }
                  aria-pressed={isSelected}
                  className="w-full text-left rounded-md px-1.5 py-1 transition-colors"
                  style={{
                    background: isSelected ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${isSelected ? 'var(--accent)' : 'transparent'}`,
                    opacity: isOtherSelected ? 0.45 : 1,
                    cursor: 'pointer',
                  }}
                >
                  <div className="flex justify-between mb-0.5">
                    <span style={{ color: isSelected ? 'var(--accent)' : 'var(--text-h)' }}>
                      {r.place}{' '}
                      <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                        · {r.zips.length > 1 ? 'multiple' : r.zips[0]}
                      </span>
                    </span>
                    <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                      {fmtInt(r.workerCount)} · {fmtPct(share)}
                    </span>
                  </div>
                  <div
                    className="h-[3px] rounded-full overflow-hidden"
                    style={{ background: 'rgba(255,255,255,0.05)' }}
                  >
                    <div
                      className="h-full"
                      style={{
                        width: `${barW}%`,
                        background: 'var(--accent)',
                        opacity: isSelected ? 1 : 0.8,
                      }}
                    />
                  </div>
                </button>
              </li>
            );
          })}
          {remainderCount > 0 && (
            <li className="text-xs">
              <div className="flex justify-between mb-0.5">
                <span style={{ color: 'var(--text-h)' }}>All other workplace ZIP codes</span>
                <span className="tnum" style={{ color: 'var(--text-dim)' }}>
                  {fmtInt(remainderCount)} ·{' '}
                  {fmtPct(remainderCount / Math.max(1, headlineTotal))}
                </span>
              </div>
              <div
                className="h-[3px] rounded-full overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.05)' }}
              >
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
          {top10.length === 0 && (
            <li className="text-xs italic" style={{ color: 'var(--text-dim)' }}>
              No anchor commute flows from {bundle.place} in this view.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
