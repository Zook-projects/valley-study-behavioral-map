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
// re-aggregate against the filtered inbound set. The "Outside of …" tiles
// remain pinned to the unfiltered set because direction is not meaningful
// for the off-map residual.
//
// Layout: a single hero row (Total Workforce) sits above a click-to-expand
// accordion list of the remaining stats. The Workplace ZIP-code rankings
// section follows beneath. Earlier prototypes carried a layout picker
// (List / Grid / Hero); Hero was selected and the others have been pruned.

import { useCallback, useMemo, useState } from 'react';
import type { DirectionFilter, FlowRow, ZipMeta } from '../types/flow';
import {
  computeAggregated,
  computeAnchorRankings,
  meanCommuteMiles,
  type AnchorRanking,
  type DriveDistanceMap,
} from '../lib/flowQueries';
import { fmtInt, fmtPct } from '../lib/format';

const DIRECTION_FILTER_LABEL: Record<Exclude<DirectionFilter, 'all'>, string> = {
  east: 'east-direction',
  west: 'west-direction',
  'up-valley': 'up-valley (anchor workplaces + eastern-I-70 residences)',
  'down-valley': 'down-valley (excludes eastern-I-70 → inner-RF commutes)',
};

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
  // Section layout. Default 'stacked' — the original Map-view layout (hero +
  // accordion above, rankings below). 'side-by-side' lays the hero+accordion
  // and the rankings into a 2-column grid for wider surfaces (the Dashboard
  // view). The internal rankingFilter still wires both halves together so
  // clicking a row in the rankings narrows the headline tiles.
  layout?: 'stacked' | 'side-by-side';
  // When true, the accordion of stat tail items renders pre-expanded so all
  // sub-line context is visible without click. Used by the Dashboard view's
  // region pane where vertical real estate is plentiful.
  defaultExpanded?: boolean;
}

// ---------------------------------------------------------------------------
// Shared types + data extraction
// ---------------------------------------------------------------------------

interface StatItem {
  id: string;
  label: string;
  value: string;
  sub: string;
  // Optional second sub-line. Currently used only by the Total Workforce
  // hero tile to surface "X% of mapped workforce" — the ratio of the
  // currently-filtered total to the absolute regional baseline (the full
  // un-narrowed, un-direction-filtered, un-segment-filtered inbound total).
  // Responds to direction, segment, and ranking filters because the
  // numerator moves while the denominator stays pinned.
  secondary?: string;
}

function buildItems(
  props: Props,
  // Absolute regional total workforce baseline (sum of inbound across all
  // 11 anchors, no direction / segment / ranking filtering applied). Used
  // as the denominator for the workforce hero's secondary "% of mapped
  // workforce" line. Caller computes from the un-narrowed `flowsInbound`
  // prop to keep the denominator stable while filters re-aggregate the
  // numerator.
  mappedWorkforceTotal: number,
): StatItem[] {
  const {
    flowsInbound,
    directionFilteredInbound,
    directionFilter,
    topCorridorInbound,
    zips,
    driveDistance,
  } = props;

  const summary = computeAggregated(directionFilteredInbound);
  const unfiltered = computeAggregated(flowsInbound);
  const avgMiles = meanCommuteMiles(flowsInbound, zips, driveDistance ?? undefined);
  const distanceSub = driveDistance
    ? 'worker-weighted, road miles, cross-ZIP only'
    : 'worker-weighted, straight-line × 1.25, cross-ZIP only';
  const filterActive = directionFilter !== 'all';

  const mappedShare =
    mappedWorkforceTotal > 0 ? summary.totalWorkers / mappedWorkforceTotal : 0;

  // The 'workforce' hero item is built in StatsAggregated so it can switch
  // label/value with the active rankings axis (Total / Inbound / Outbound /
  // Local). buildItems still emits a placeholder item here so the hero ID
  // anchor stays in the items list — StatsAggregated overrides it before
  // rendering. Keeps the legacy mappedShare computation around so the
  // override has a sensible fallback when axis === 'total'.
  void mappedShare;
  const items: StatItem[] = [
    {
      id: 'workforce',
      label: 'Total Workforce',
      value: fmtInt(summary.totalWorkers),
      sub: 'working within the 11 workplace ZIP codes',
      secondary: undefined,
    },
    {
      id: 'cross-zip',
      label: 'Cross-ZIP commuters',
      value: fmtInt(summary.crossZipCommuters),
      sub: `${fmtPct(summary.crossZipShare)} of mapped workforce commutes`,
    },
    {
      id: 'avg-distance',
      label: 'Average commute distance',
      value: `${avgMiles.toFixed(1)} mi`,
      sub: distanceSub,
    },
  ];

  if (topCorridorInbound) {
    items.push({
      id: 'top-corridor',
      label: 'Top corridor',
      value: fmtInt(topCorridorInbound.total),
      sub: topCorridorInbound.label,
    });
  }

  if (summary.topOutbound) {
    items.push({
      id: 'top-od-pair',
      label: 'Top origin–destination pair',
      value: fmtInt(summary.topOutbound.workerCount),
      sub: `${summary.topOutbound.originPlace} → ${summary.topOutbound.destPlace}`,
    });
  }

  items.push({
    id: 'outside-anchors',
    label: 'Outside of the ZIP Codes',
    value: fmtPct(unfiltered.outsideAnchorsShare),
    sub: filterActive
      ? 'inbound workforce with residence outside the 11 ZIP codes · direction filter N/A'
      : 'inbound workforce with residence outside the 11 ZIP codes',
  });

  items.push({
    id: 'outside-state',
    label: 'Outside of the State',
    value: fmtPct(unfiltered.outsideStateShare),
    sub: filterActive
      ? 'inbound workforce with out-of-state or unmappable residence · direction filter N/A'
      : 'inbound workforce with out-of-state or unmappable residence',
  });

  return items;
}

// ---------------------------------------------------------------------------
// Accordion list — used for the Hero layout's tail rows.
// ---------------------------------------------------------------------------

function AccordionRow({
  item,
  open,
  onToggle,
}: {
  item: StatItem;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="border-b last:border-0"
      style={{ borderColor: 'var(--rule)' }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 py-2 text-left focus:outline-none focus-visible:ring-1 rounded-sm"
      >
        <span
          className="text-[10px] font-medium uppercase tracking-wider truncate"
          style={{ color: 'var(--text-dim)' }}
        >
          {item.label}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span
            className="text-sm font-semibold tnum whitespace-nowrap"
            style={{ color: 'var(--text-h)' }}
          >
            {item.value}
          </span>
          <span
            aria-hidden="true"
            className="text-[12px] leading-none transition-transform"
            style={{
              color: 'var(--text-dim)',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ›
          </span>
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div
            className="pb-2 text-xs leading-snug"
            style={{ color: 'var(--text-dim)' }}
          >
            {item.sub}
          </div>
        </div>
      </div>
    </div>
  );
}

function LayoutAccordion({
  items,
  defaultExpanded = false,
}: {
  items: StatItem[];
  defaultExpanded?: boolean;
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => (defaultExpanded ? new Set(items.map((it) => it.id)) : new Set()),
  );
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div>
      {items.map((it) => (
        <AccordionRow
          key={it.id}
          item={it}
          open={openIds.has(it.id)}
          onToggle={() => toggle(it.id)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero row + condensed accordion list
// ---------------------------------------------------------------------------

function HeroRow({ item }: { item: StatItem }) {
  return (
    <div
      className="py-2.5 border-b last:border-0"
      style={{ borderColor: 'var(--rule)' }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        {item.label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div
          className="text-xl font-semibold tnum whitespace-nowrap"
          style={{ color: 'var(--text-h)' }}
        >
          {item.value}
        </div>
        <div className="text-xs tnum" style={{ color: 'var(--text-dim)' }}>
          {item.sub}
        </div>
      </div>
      {item.secondary && (
        <div
          className="mt-0.5 text-xs tnum"
          style={{ color: 'var(--text-dim)' }}
        >
          {item.secondary}
        </div>
      )}
    </div>
  );
}

function LayoutHero({
  items,
  defaultExpanded = false,
}: {
  items: StatItem[];
  defaultExpanded?: boolean;
}) {
  const heroIds = new Set(['workforce']);
  const heroItems = items.filter((it) => heroIds.has(it.id));
  const tailItems = items.filter((it) => !heroIds.has(it.id));
  return (
    <div>
      {heroItems.map((it) => (
        <HeroRow key={it.id} item={it} />
      ))}
      <div className="mt-1">
        <LayoutAccordion items={tailItems} defaultExpanded={defaultExpanded} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-anchor rankings section — four ranked views (Total, Inbound, Outbound,
// Local) over the 11 workplace anchors. "Total" is the WAC-style total
// workforce at each anchor (inbound + within-ZIP). Re-aggregates against the
// active direction filter so the rankings reflect the same scope as the rest
// of the aggregate dashboard. With a direction filter active, ALL_OTHER flows
// drop out of the inbound/outbound counts (out-of-state has no compass
// direction); within-ZIP self-flows are preserved by `filterByDirection`.
// ---------------------------------------------------------------------------

type RankAxis = 'total' | 'inbound' | 'outbound' | 'local';

const RANK_AXES: ReadonlyArray<{ key: RankAxis; label: string }> = [
  { key: 'total', label: 'Total' },
  { key: 'inbound', label: 'Inbound' },
  { key: 'outbound', label: 'Outbound' },
  { key: 'local', label: 'Local' },
];

const RANK_HELP: Record<RankAxis, { primary: string; secondary?: string }> = {
  total: {
    primary: 'Total workforce at the ZIP code = inbound + within-ZIP',
    secondary: '% of all 11 ZIP codes’ combined workforce',
  },
  inbound: {
    primary: 'Workers commuting into the ZIP code from elsewhere',
    secondary: '% of ZIP code workforce (in ÷ (in + within-ZIP))',
  },
  outbound: {
    primary: 'Residents commuting out of the ZIP code for work',
    secondary: '% of ZIP code residents (out ÷ (out + within-ZIP))',
  },
  local: {
    primary: 'Workers who live and work in the same ZIP code',
    secondary: '% of ZIP code workforce (within-ZIP ÷ (in + within-ZIP))',
  },
};

function valueFor(r: AnchorRanking, axis: RankAxis): number {
  if (axis === 'outbound') return r.outboundCommuters;
  if (axis === 'inbound') return r.inboundCommuters;
  if (axis === 'total') return r.inboundCommuters + r.withinZip;
  return r.withinZip;
}

// Hero-row label / sub / secondary descriptor per axis. The hero swaps
// these when the user picks a tab in the Workplace ZIP Code Rankings so
// the headline metric tracks the rankings the user is actively reading.
const HERO_BY_AXIS: Record<RankAxis, {
  label: string;
  sub: string;
  // Used in the secondary line as: "X% of {secondaryDescriptor}".
  secondaryDescriptor: string;
}> = {
  total: {
    label: 'Total Workforce',
    sub: 'working within the 11 workplace ZIP codes',
    secondaryDescriptor: 'mapped workforce',
  },
  inbound: {
    label: 'Inbound Commuters',
    sub: 'workers commuting INTO the 11 workplace ZIP codes',
    secondaryDescriptor: 'regional inbound commuters',
  },
  outbound: {
    label: 'Outbound Commuters',
    sub: 'residents commuting OUT of the 11 ZIP codes for work',
    secondaryDescriptor: 'regional outbound commuters',
  },
  local: {
    label: 'Local Workforce',
    sub: 'workers living and working in the same ZIP code',
    secondaryDescriptor: 'regional local workforce',
  },
};

function fmtAxisValue(v: number, axis: RankAxis): string {
  void axis;
  return fmtInt(v);
}

// Anchor-internal share shown alongside the primary count. For the Total
// axis the share is regional (row total ÷ sum of all rows' total workforce),
// so the caller passes that regional sum in.
function secondaryPercent(
  r: AnchorRanking,
  axis: RankAxis,
  regionalTotal: number,
): number | null {
  if (axis === 'outbound') {
    const denom = r.outboundCommuters + r.withinZip;
    return denom > 0 ? r.outboundCommuters / denom : 0;
  }
  if (axis === 'inbound') {
    const denom = r.inboundCommuters + r.withinZip;
    return denom > 0 ? r.inboundCommuters / denom : 0;
  }
  if (axis === 'total') {
    const v = r.inboundCommuters + r.withinZip;
    return regionalTotal > 0 ? v / regionalTotal : 0;
  }
  return r.localShare;
}

// Which numeric attribute drives both the sort order and the "primary"
// (bright/white) display column. # = absolute count, % = secondary share.
type RankSortBy = 'count' | 'percent';

function AnchorRankings({
  rankings,
  selectedFilter,
  onToggleFilter,
  directionFilter,
  axis,
  onAxisChange,
}: {
  rankings: AnchorRanking[];
  // Set of currently-selected workplace ZIPs. When non-empty the rows in
  // the set render with an active background and the headline tiles above
  // re-aggregate to those ZIPs only. Empty = no filter. Clearing the filter
  // is handled by the status banner in StatsAggregated, not inside this list.
  selectedFilter: Set<string>;
  onToggleFilter: (zip: string) => void;
  directionFilter: DirectionFilter;
  // Lifted axis state — owned by StatsAggregated so the hero row stays in
  // sync with whichever axis tab the user has selected here.
  axis: RankAxis;
  onAxisChange: (next: RankAxis) => void;
}) {
  const setAxis = onAxisChange;
  const [sortBy, setSortBy] = useState<RankSortBy>('count');

  const regionalTotal = useMemo(
    () =>
      rankings.reduce(
        (sum, r) => sum + r.inboundCommuters + r.withinZip,
        0,
      ),
    [rankings],
  );

  // Sort key matches whichever column is "primary" for the current sortBy.
  // For 'percent' we sort by the same secondaryPercent the row renders, so
  // the visual order mirrors the right-hand column. Hoisted as a useCallback
  // so both the memoized sort and the bar-fill `max` calculation share a
  // single closure — and the linter can verify the dep set without an
  // eslint-disable escape hatch.
  const sortKeyFor = useCallback(
    (r: AnchorRanking): number => {
      if (sortBy === 'percent') {
        return secondaryPercent(r, axis, regionalTotal) ?? 0;
      }
      return valueFor(r, axis);
    },
    [axis, sortBy, regionalTotal],
  );

  const sorted = useMemo(
    () => [...rankings].sort((a, b) => sortKeyFor(b) - sortKeyFor(a)),
    [rankings, sortKeyFor],
  );
  // Bar-fill scale follows the same attribute that drives the sort, so the
  // visual bar always corresponds to the column the user chose to rank by.
  const max =
    sorted.length > 0 ? Math.max(sortKeyFor(sorted[0]), 1e-9) : 1;
  const help = RANK_HELP[axis];

  return (
    <div className="mt-4 pt-3 border-t" style={{ borderColor: 'var(--rule)' }}>
      {/* Header row: section label on the left, sort toggle on the right.
          The toggle sits ABOVE the axis tablist and switches both the sort
          order and which numeric column is rendered as the "bright" value. */}
      <div className="flex items-center justify-between mb-2">
        <div
          className="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          Workplace Zip Code rankings
        </div>
        <div
          role="tablist"
          aria-label="Sort rankings by"
          className="flex p-0.5 rounded-md border text-[10px]"
          style={{
            background: 'rgba(255,255,255,0.03)',
            borderColor: 'var(--panel-border)',
          }}
        >
          {([
            { key: 'count', label: '#' },
            { key: 'percent', label: '%' },
          ] as Array<{ key: RankSortBy; label: string }>).map(({ key, label }) => {
            const active = sortBy === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSortBy(key)}
                aria-label={`Sort by ${key === 'count' ? 'count' : 'percent'}`}
                className="px-2 py-0.5 rounded transition-colors font-medium tnum"
                style={{
                  background: active ? 'var(--accent)' : 'transparent',
                  color: active ? '#1a1207' : 'var(--text-dim)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Ranking axis"
        className="flex p-1 rounded-lg border mb-2"
        style={{
          background: 'rgba(255,255,255,0.03)',
          borderColor: 'var(--panel-border)',
        }}
      >
        {RANK_AXES.map(({ key, label }) => {
          const active = axis === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => setAxis(key)}
              className="flex-1 px-3 py-1 text-[11px] font-medium rounded-md transition-colors"
              style={{
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? '#1a1207' : 'var(--text)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        className="text-[11px] leading-snug mb-2"
        style={{ color: 'var(--text-dim)' }}
      >
        <div>{help.primary}</div>
        {help.secondary && (
          <div className="opacity-80">{help.secondary}</div>
        )}
        {directionFilter !== 'all' && (
          <div className="opacity-80 mt-0.5">
            Scoped to {DIRECTION_FILTER_LABEL[directionFilter]} flows · ALL_OTHER excluded
          </div>
        )}
      </div>

      <ol className="flex flex-col gap-0.5 pl-0">
        {sorted.map((r, idx) => {
          const v = valueFor(r, axis);
          const secondary = secondaryPercent(r, axis, regionalTotal);
          // Bar fill follows whichever attribute is currently sorted on, so
          // the bar reads consistently with the bright value column.
          const sortKey = sortBy === 'percent' ? (secondary ?? 0) : v;
          const pct = Math.max(0, Math.min(100, (sortKey / max) * 100));
          // Swap which column gets the bright `text-h` color based on sortBy.
          // The non-sorted column drops to `text-dim` so the active column is
          // always the visually emphasized one.
          const countColor =
            sortBy === 'count' ? 'var(--text-h)' : 'var(--text-dim)';
          const percentColor =
            sortBy === 'percent' ? 'var(--text-h)' : 'var(--text-dim)';
          const isSelected = selectedFilter.has(r.zip);
          const handleClick = () => onToggleFilter(r.zip);
          return (
            <li key={r.zip}>
              <button
                type="button"
                onClick={handleClick}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? 'Remove' : 'Add'} ${r.place} (ZIP ${r.zip}) ${isSelected ? 'from' : 'to'} stats filter`}
                className="w-full flex items-center gap-2 py-1 px-1 text-[11px] text-left rounded-sm transition-colors hover:bg-white/[0.05] focus:outline-none focus-visible:ring-1"
                style={
                  isSelected
                    ? {
                        // Active filter row — same accent treatment used for
                        // selected ZIP chips in ZipSelector so the visual
                        // language reads consistently across the panel.
                        background: 'rgba(244, 191, 79, 0.12)',
                        boxShadow: 'inset 0 0 0 1px rgba(244, 191, 79, 0.55)',
                      }
                    : undefined
                }
              >
                <span
                  className="tnum w-4 shrink-0 text-right"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {idx + 1}
                </span>
                <span
                  className="w-28 shrink-0 truncate"
                  style={{ color: 'var(--text)' }}
                  title={r.place}
                >
                  {r.place}
                </span>
                <span
                  className="relative flex-1 h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                  aria-hidden="true"
                >
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: 'var(--accent)',
                      opacity: 0.78,
                    }}
                  />
                </span>
                <span
                  className="tnum w-14 shrink-0 text-right font-medium"
                  style={{ color: countColor }}
                >
                  {fmtAxisValue(v, axis)}
                </span>
                {secondary !== null && (
                  <span
                    className="tnum w-9 shrink-0 text-right text-[10px]"
                    style={{ color: percentColor }}
                    aria-label={
                      axis === 'total'
                        ? `${fmtPct(secondary)} of regional total workforce`
                        : `${fmtPct(secondary)} of ZIP code ${axis === 'outbound' ? 'residents' : 'workforce'}`
                    }
                  >
                    {fmtPct(secondary)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function StatsAggregated(props: Props) {
  // Local panel-only filter — clicking a row in AnchorRankings toggles its
  // ZIP into this set. Headline tiles re-aggregate against flows narrowed
  // to destZip ∈ filter; the rankings list itself stays unfiltered so the
  // user can compare against the rest of the valley while toggling. Empty
  // set means "no filter" — identical behavior to pre-filter aggregate view.
  const [rankingFilter, setRankingFilter] = useState<Set<string>>(
    () => new Set(),
  );
  const filterActive = rankingFilter.size > 0;
  // Lifted from AnchorRankings so the hero row above the rankings can swap
  // its label, value, and share line whenever the user picks a different
  // axis tab. Cross-filtering (rankingFilter) composes with the axis: the
  // hero shows the per-axis sum for the selected anchors, or for the full
  // 11 anchors when no rankings rows are toggled.
  const [rankingAxis, setRankingAxis] = useState<RankAxis>('total');

  const toggleRankingFilter = (zip: string) => {
    setRankingFilter((prev) => {
      const next = new Set(prev);
      if (next.has(zip)) next.delete(zip);
      else next.add(zip);
      return next;
    });
  };
  const clearRankingFilter = () => setRankingFilter(new Set());

  // Narrow the inbound flow arrays to flows landing in the selected anchor(s)
  // when the filter is active. The "Outside" tiles read off `flowsInbound`
  // (unfiltered by direction) so we narrow that one too.
  const narrowedDirectionFilteredInbound = useMemo(() => {
    if (!filterActive) return props.directionFilteredInbound;
    return props.directionFilteredInbound.filter((f) =>
      rankingFilter.has(f.destZip),
    );
  }, [filterActive, props.directionFilteredInbound, rankingFilter]);
  const narrowedFlowsInbound = useMemo(() => {
    if (!filterActive) return props.flowsInbound;
    return props.flowsInbound.filter((f) => rankingFilter.has(f.destZip));
  }, [filterActive, props.flowsInbound, rankingFilter]);

  // Absolute baseline for the workforce hero's "% of mapped workforce"
  // sub-line. Computed off the un-narrowed `props.flowsInbound` so the
  // denominator stays pinned while the numerator (computed inside
  // buildItems off the narrowed/direction/segment-filtered set) moves.
  const mappedWorkforceTotal = useMemo(
    () => computeAggregated(props.flowsInbound).totalWorkers,
    [props.flowsInbound],
  );

  const baseItems = buildItems(
    {
      ...props,
      flowsInbound: narrowedFlowsInbound,
      directionFilteredInbound: narrowedDirectionFilteredInbound,
      // Top Corridor is pre-computed upstream against the regional flow
      // set and can't be cheaply recomputed here. Hide the tile when the
      // local filter is active so it doesn't display a stat that disagrees
      // with the rest of the panel.
      topCorridorInbound: filterActive ? null : props.topCorridorInbound,
    },
    mappedWorkforceTotal,
  );

  // Rankings are computed off the un-narrowed direction-filtered arrays so
  // every anchor stays visible regardless of filter state.
  const rankings = useMemo(
    () =>
      computeAnchorRankings(
        props.directionFilteredInbound,
        props.directionFilteredOutbound ?? [],
        props.zips,
      ),
    [props.directionFilteredInbound, props.directionFilteredOutbound, props.zips],
  );

  // Un-direction-filtered ranking baseline — used as the denominator for
  // the hero's "% of regional X" share line. With no direction or ranking
  // filter active the share resolves to 100%; activating either filter
  // shrinks it to the visible slice of the regional total for the axis.
  const unfilteredRankings = useMemo(
    () =>
      computeAnchorRankings(
        props.flowsInbound,
        props.flowsOutbound ?? [],
        props.zips,
      ),
    [props.flowsInbound, props.flowsOutbound, props.zips],
  );

  // Per-axis hero numerator: sum the active axis across the rankings the
  // user has highlighted (all anchors when no rankings rows are toggled).
  const heroAxisRankings = useMemo(
    () => (filterActive ? rankings.filter((r) => rankingFilter.has(r.zip)) : rankings),
    [filterActive, rankings, rankingFilter],
  );
  const heroAxisValue = useMemo(
    () => heroAxisRankings.reduce((sum, r) => sum + valueFor(r, rankingAxis), 0),
    [heroAxisRankings, rankingAxis],
  );
  const heroAxisBaseline = useMemo(
    () => unfilteredRankings.reduce((sum, r) => sum + valueFor(r, rankingAxis), 0),
    [unfilteredRankings, rankingAxis],
  );
  const heroAxisShare = heroAxisBaseline > 0 ? heroAxisValue / heroAxisBaseline : 0;
  const heroDescriptor = HERO_BY_AXIS[rankingAxis];
  const heroItem: StatItem = {
    id: 'workforce',
    label: heroDescriptor.label,
    value: fmtInt(heroAxisValue),
    sub: heroDescriptor.sub,
    secondary: `${fmtPct(heroAxisShare)} of ${heroDescriptor.secondaryDescriptor}`,
  };
  // Replace the buildItems placeholder workforce row with the axis-aware
  // hero so LayoutHero (which keys off id === 'workforce') picks up the
  // live rankings axis selection. Done after heroItem is constructed so
  // the temporal-dead-zone reference order is correct.
  const items = baseItems.map((item) => (item.id === 'workforce' ? heroItem : item));

  // Friendly label for the active filter — surfaced above the hero so the
  // user always knows the headline tiles are scoped. Single-ZIP filter
  // names the place; multi-ZIP filter shows the count.
  const filterLabel = useMemo(() => {
    if (!filterActive) return null;
    if (rankingFilter.size === 1) {
      const z = rankingFilter.values().next().value as string;
      const meta = props.zips.find((m) => m.zip === z);
      return meta?.place ?? z;
    }
    return `${rankingFilter.size} ZIPs`;
  }, [filterActive, rankingFilter, props.zips]);

  const sideBySide = props.layout === 'side-by-side';

  return (
    <div>
      {filterActive && filterLabel && (
        <div
          className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md mb-1.5 text-[10px] uppercase tracking-wider"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--panel-border)',
            color: 'var(--text-dim)',
          }}
        >
          <span>
            Filtered to{' '}
            <span style={{ color: 'var(--text-h)' }}>{filterLabel}</span>
          </span>
          <button
            type="button"
            onClick={clearRankingFilter}
            className="font-medium hover:underline focus:outline-none focus-visible:underline"
            style={{ color: 'var(--accent)' }}
          >
            Clear
          </button>
        </div>
      )}
      {sideBySide ? (
        // Two-column on md+: hero/accordion left, rankings right. Stacks
        // back to a single column on mobile so neither half collapses.
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          <div className="min-w-0">
            <LayoutHero items={items} defaultExpanded={props.defaultExpanded} />
          </div>
          <div className="min-w-0">
            <AnchorRankings
              rankings={rankings}
              selectedFilter={rankingFilter}
              onToggleFilter={toggleRankingFilter}
              directionFilter={props.directionFilter}
              axis={rankingAxis}
              onAxisChange={setRankingAxis}
            />
          </div>
        </div>
      ) : (
        <>
          <LayoutHero items={items} defaultExpanded={props.defaultExpanded} />
          <AnchorRankings
            rankings={rankings}
            selectedFilter={rankingFilter}
            onToggleFilter={toggleRankingFilter}
            directionFilter={props.directionFilter}
            axis={rankingAxis}
            onAxisChange={setRankingAxis}
          />
        </>
      )}
    </div>
  );
}
