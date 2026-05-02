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

import { useMemo, useState } from 'react';
import type { DirectionFilter, FlowRow, ZipMeta } from '../types/flow';
import {
  computeAggregated,
  computeAnchorRankings,
  meanCommuteMiles,
  type AnchorRanking,
  type DriveDistanceMap,
} from '../lib/flowQueries';
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
  // Optional — passed through to the per-anchor rankings so a row click
  // selects the anchor (same effect as clicking its chip in ZipSelector).
  onSelectZip?: (zip: string | null) => void;
}

// ---------------------------------------------------------------------------
// Shared types + data extraction
// ---------------------------------------------------------------------------

interface StatItem {
  id: string;
  label: string;
  value: string;
  sub: string;
}

function buildItems(props: Props): StatItem[] {
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

  const items: StatItem[] = [
    {
      id: 'workforce',
      label: 'Total Workforce',
      value: fmtInt(summary.totalWorkers),
      sub: 'working within the 11 workplace ZIP codes',
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

function LayoutAccordion({ items }: { items: StatItem[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
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
    </div>
  );
}

function LayoutHero({ items }: { items: StatItem[] }) {
  const heroIds = new Set(['workforce']);
  const heroItems = items.filter((it) => heroIds.has(it.id));
  const tailItems = items.filter((it) => !heroIds.has(it.id));
  return (
    <div>
      {heroItems.map((it) => (
        <HeroRow key={it.id} item={it} />
      ))}
      <div className="mt-1">
        <LayoutAccordion items={tailItems} />
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
  onSelectZip,
  directionFilter,
}: {
  rankings: AnchorRanking[];
  onSelectZip?: (zip: string | null) => void;
  directionFilter: DirectionFilter;
}) {
  const [axis, setAxis] = useState<RankAxis>('total');
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
  // the visual order mirrors the right-hand column.
  const sortKeyFor = (r: AnchorRanking): number => {
    if (sortBy === 'percent') {
      return secondaryPercent(r, axis, regionalTotal) ?? 0;
    }
    return valueFor(r, axis);
  };

  const sorted = useMemo(
    () => [...rankings].sort((a, b) => sortKeyFor(b) - sortKeyFor(a)),
    // sortKeyFor is recomputed inline; deps capture every input that
    // changes its return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rankings, axis, sortBy, regionalTotal],
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
            Scoped to {directionFilter}-direction flows · ALL_OTHER excluded
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
          const handleClick = () => onSelectZip?.(r.zip);
          return (
            <li key={r.zip}>
              <button
                type="button"
                onClick={handleClick}
                aria-label={`Select ${r.place} (ZIP ${r.zip})`}
                className="w-full flex items-center gap-2 py-1 px-1 text-[11px] text-left rounded-sm transition-colors hover:bg-white/[0.05] focus:outline-none focus-visible:ring-1"
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
  const items = buildItems(props);
  const rankings = useMemo(
    () =>
      computeAnchorRankings(
        props.directionFilteredInbound,
        props.directionFilteredOutbound ?? [],
        props.zips,
      ),
    [props.directionFilteredInbound, props.directionFilteredOutbound, props.zips],
  );

  return (
    <div>
      <LayoutHero items={items} />
      <AnchorRankings
        rankings={rankings}
        onSelectZip={props.onSelectZip}
        directionFilter={props.directionFilter}
      />
    </div>
  );
}
