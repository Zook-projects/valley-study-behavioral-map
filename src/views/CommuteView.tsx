// CommuteView — top-level layout for the commute (LEHD LODES) dataset. The
// shell App.tsx renders this when `dataset === 'commute'`; the visitor view
// is its sibling. The body below is the original App.tsx code preserved
// verbatim so the commute view's behavior is unchanged by the dataset
// refactor — only the import paths shifted by one directory and the export
// name changed from `App` to `CommuteView`.
//
// Loads flows-inbound.json, flows-outbound.json,
// zips.json, and corridors.json on mount, owns selection + mode state, and
// composes DashboardTile + MapCanvas + the corridor hover tooltip.
//
// Mode is strictly exclusive: at any moment the map renders either inbound
// flows (workplace anchor's home-ZIP fan-in) or outbound flows (residence
// anchor's work-ZIP fan-out). The hover tooltip's aggregation, denominator,
// and label set follow the active mode.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MapCanvas } from '../components/MapCanvas';
import { DashboardTile } from '../components/DashboardTile';
import { BottomCardStrip } from '../components/BottomCardStrip';
import { ActiveFiltersOverlay } from '../components/ActiveFiltersOverlay';
import { HeatmapLegend } from '../components/HeatmapLegend';
import type { ViewLayer } from '../components/ViewLayerToggle';
import type {
  ActiveCorridorAggregation,
  CorridorFlowEntry,
  CorridorGraph,
  CorridorId,
  CorridorRecord,
  DirectionFilter,
  FlowRow,
  Mode,
  PassThroughFile,
  SegmentFilter,
  ZipMeta,
} from '../types/flow';
import type { OdBlocksFile, OdSummaryFile, RacFile, WacFile } from '../types/lodes';
import { buildHeatmapGeoJson } from '../lib/heatmapPoints';
import {
  applySegmentFilter,
  detailForNonAnchorOrigin,
  detailForZip,
  filterByDirection,
  filterForSelection,
  isAnchorZip,
  unionFlowsByPair,
  type DriveDistanceMap,
} from '../lib/flowQueries';
import {
  buildCorridorFlowIndex,
  buildVisibleCorridorMap,
  indexCorridors,
} from '../lib/corridors';
import {
  exportCorridor,
  exportRegion,
  exportWorkplace,
} from '../lib/exportXlsx';
import { computeBucketBreaks } from '../lib/arcMath';
import { fmtInt, fmtPct } from '../lib/format';

interface HoverState {
  corridorId: CorridorId;
  aggregation: ActiveCorridorAggregation;
  clientX: number;
  clientY: number;
}

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

/** Pretty-format a tooltip row's place + ZIP label. */
function placeLabel(zips: ZipMeta[], zip: string): string {
  const m = zips.find((z) => z.zip === zip);
  return m?.place || zip;
}

/**
 * Tooltip body — render an ordered table of destinations (outbound) or origins
 * (inbound), sorted descending by worker count. Top-8 rows; remaining rows
 * roll up into a "+ X more" residual.
 */
// Clamp a tooltip's anchor point so its rendered footprint stays inside the
// viewport. The hover variant uses this to flip from below-right of the
// cursor (default offset +14/+14) to above/left when the cursor is near the
// right or bottom edge. Width/height are estimates — the tooltip's actual
// box is a bit smaller, so the clamp is conservative.
function clampTooltipAnchor(
  clientX: number,
  clientY: number,
  estWidth: number,
  estHeight: number,
): { left: number; top: number } {
  const margin = 12;
  const offset = 14;
  const vw =
    typeof window !== 'undefined' ? window.innerWidth : estWidth + offset * 2;
  const vh =
    typeof window !== 'undefined' ? window.innerHeight : estHeight + offset * 2;
  // Default: below-right of cursor. Flip to left when overflowing right edge,
  // and to above when overflowing bottom edge.
  let left = clientX + offset;
  let top = clientY + offset;
  if (left + estWidth + margin > vw) left = clientX - offset - estWidth;
  if (top + estHeight + margin > vh) top = clientY - offset - estHeight;
  // Final safety clamp so a small viewport never pushes the box off-screen.
  left = Math.max(margin, Math.min(left, vw - estWidth - margin));
  top = Math.max(margin, Math.min(top, vh - estHeight - margin));
  return { left, top };
}

function TooltipBody({
  aggregation,
  direction,
  zips,
  onSelectPartner,
  selectedPartner,
  topN = 8,
}: {
  aggregation: ActiveCorridorAggregation;
  // 'residence' renders byOriginZip (where workers come from);
  // 'workplace' renders byDestZip (where workers go).
  direction: 'residence' | 'workplace';
  zips: ZipMeta[];
  // When provided, ZIP rows in the breakdown table become clickable —
  // tapping a row sets the partner filter via the same handler the left-rail
  // "Top 10" list uses, scoping the map and stats to flows touching the
  // chosen place.
  onSelectPartner?: (p: { place: string; zips: string[] }) => void;
  selectedPartner?: { place: string; zips: string[] } | null;
  topN?: number;
}) {
  const map =
    direction === 'workplace' ? aggregation.byDestZip : aggregation.byOriginZip;
  const total = aggregation.total || 1;

  // Group ZIPs that share a place name (e.g., Eagle 81631 + 81637) into one
  // row so a single city doesn't split across multiple lines in the tooltip.
  type GroupRow = { place: string; zips: string[]; count: number };
  const groupMap = new Map<string, GroupRow>();
  for (const [zip, count] of map.entries()) {
    const place = placeLabel(zips, zip);
    const existing = groupMap.get(place);
    if (existing) {
      existing.count += count;
      if (!existing.zips.includes(zip)) existing.zips.push(zip);
    } else {
      groupMap.set(place, { place, zips: [zip], count });
    }
  }
  for (const r of groupMap.values()) r.zips.sort();
  const rows = Array.from(groupMap.values()).sort(
    (a, b) => (b.count - a.count) || a.place.localeCompare(b.place),
  );

  const top = rows.slice(0, topN);
  const rest = rows.slice(topN);
  const restCount = rest.reduce((s, r) => s + r.count, 0);

  // ZIP-row click target: the entire grouped place (place + every ZIP that
  // shares it, e.g., Eagle 81631 + 81637). Mirrors the left-rail "Top 10"
  // list so the same partner filter shape is used everywhere.
  const handleRowClick = onSelectPartner
    ? (place: string, zipsInGroup: string[]) => {
        onSelectPartner({ place, zips: zipsInGroup });
      }
    : undefined;

  return (
    <table className="w-full text-[11px] tnum mt-1">
      <tbody>
        {top.map((r) => {
          const isSelected = selectedPartner?.place === r.place;
          const rowClass =
            'transition-colors' +
            (handleRowClick ? ' cursor-pointer hover:bg-white/5' : '');
          return (
            <tr
              key={r.place}
              className={rowClass}
              onClick={
                handleRowClick ? () => handleRowClick(r.place, r.zips) : undefined
              }
              role={handleRowClick ? 'button' : undefined}
              aria-pressed={handleRowClick ? isSelected : undefined}
              aria-label={
                handleRowClick
                  ? `Filter to ${r.place} (${r.zips.length > 1 ? 'multiple ZIPs' : r.zips[0]})`
                  : undefined
              }
              style={{
                background: isSelected ? 'var(--accent-soft)' : undefined,
              }}
            >
              <td
                className="pr-2 align-baseline"
                style={{ color: isSelected ? 'var(--accent)' : 'var(--text-h)' }}
              >
                {r.place}{' '}
                <span style={{ color: 'var(--text-dim)' }}>
                  · {r.zips.length > 1 ? 'multiple' : r.zips[0]}
                </span>
              </td>
              <td className="text-right pr-2" style={{ color: 'var(--text)' }}>
                {fmtInt(r.count)}
              </td>
              <td className="text-right" style={{ color: 'var(--text-dim)' }}>
                {fmtPct(r.count / total)}
              </td>
            </tr>
          );
        })}
        {rest.length > 0 && (
          <tr>
            <td className="pr-2 align-baseline italic" style={{ color: 'var(--text-dim)' }}>
              + {rest.length} more {direction === 'workplace' ? 'destinations' : 'origins'}
            </td>
            <td className="text-right pr-2" style={{ color: 'var(--text)' }}>
              {fmtInt(restCount)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(restCount / total)}
            </td>
          </tr>
        )}
        <tr style={{ borderTop: '1px solid var(--rule)' }}>
          <td
            className="pr-2 align-baseline pt-1 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Total
          </td>
          <td
            className="text-right pr-2 pt-1"
            style={{ color: 'var(--text-h)' }}
          >
            {fmtInt(aggregation.total)}
          </td>
          <td className="text-right pt-1" style={{ color: 'var(--text-dim)' }}>
            100%
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function CommuteView() {
  const [flowsInbound, setFlowsInbound] = useState<FlowRow[] | null>(null);
  const [flowsOutbound, setFlowsOutbound] = useState<FlowRow[] | null>(null);
  const [zips, setZips] = useState<ZipMeta[] | null>(null);
  const [corridorIndex, setCorridorIndex] = useState<Map<CorridorId, CorridorRecord> | null>(null);
  const [flowIndex, setFlowIndex] = useState<Map<CorridorId, CorridorFlowEntry[]> | null>(null);
  const [racFile, setRacFile] = useState<RacFile | null>(null);
  const [wacFile, setWacFile] = useState<WacFile | null>(null);
  const [odSummary, setOdSummary] = useState<OdSummaryFile | null>(null);
  const [driveDistance, setDriveDistance] = useState<DriveDistanceMap | null>(null);
  const [passThrough, setPassThrough] = useState<PassThroughFile | null>(null);
  // Block-level OD data (latest year only) — drives the workplace/residential
  // density heatmap painted under the flow arcs. Optional load: on a failed
  // fetch the heatmap layer simply doesn't render.
  const [odBlocks, setOdBlocks] = useState<OdBlocksFile | null>(null);
  const [mode, setMode] = useState<Mode>('inbound');
  const [selectedZip, setSelectedZip] = useState<string | null>(null);
  // Non-anchor place bundle. Set when the user selects a real ZIP that isn't
  // in ANCHOR_ZIPS — gathers every ZIP that shares the place name so multi-
  // ZIP places (Eagle, Grand Junction) aggregate across their full footprint.
  // Null when the selection is the aggregate view, an anchor, or ALL_OTHER.
  const [nonAnchorBundle, setNonAnchorBundle] = useState<
    { place: string; zips: string[] } | null
  >(null);
  // Optional secondary selection — a single partner location chosen from the
  // anchor's top-N list. When set, the map fades non-matching corridors and
  // the headline tiles + Workforce flows + Workplace Metrics scope to the
  // partner→anchor (inbound mode) or anchor→partner (outbound mode) flow.
  // The shape is place + zips because cities like Eagle and Grand Junction
  // span multiple ZCTAs and all of them must match the filter.
  const [selectedPartner, setSelectedPartner] = useState<
    { place: string; zips: string[] } | null
  >(null);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  // Spatial visualization layer — corridor (flow arcs) is the default; user
  // can flip to heatmap (block-level density) via the DashboardTile toggle.
  const [viewLayer, setViewLayer] = useState<ViewLayer>('corridor');
  // Regional-view mode — drives the corridor + heatmap visuals when no
  // anchor is selected (replaces the old "Aggregate Regional Flows" static
  // label). Decoupled from `mode` so toggling here in regional view does
  // NOT bleed into the left dashboard panel, bottom card strip, or tooltips
  // — those keep using the user's `mode` state and the deduped regional
  // flow universe.
  const [regionalViewMode, setRegionalViewMode] = useState<Mode>('inbound');
  // Segment filter — slices every cross-LODES OD aggregation by one of three
  // axes (age / wage / industry NAICS-3) at a time. LODES does not publish
  // joint cells across axes, so the filter UX commits to one axis at a time.
  // When axis === 'all' (or every bucket within an axis is selected), the
  // filter is treated as inactive and the array passes through unchanged.
  const [segmentFilter, setSegmentFilter] = useState<SegmentFilter>({
    axis: 'all',
    buckets: [],
  });
  const [hover, setHover] = useState<HoverState | null>(null);
  // Pinned tooltip state — set by clicking a corridor halo, cleared by clicking
  // a different corridor or by clicking an empty area of the map. The pinned
  // tooltip shows the full breakdown; the hover tooltip is a simplified
  // header-only chip that prompts the user to click for more.
  const [pinned, setPinned] = useState<HoverState | null>(null);
  // Bottom card strip height — tracked so the credit chip can sit just above
  // it regardless of which view (aggregate / anchor / non-anchor) is active.
  const bottomStripRef = useRef<HTMLDivElement>(null);
  const [bottomStripHeight, setBottomStripHeight] = useState<number>(348);
  // Cross-filter state for the pass-through traffic card. Either side can be
  // selected independently; when one is set the opposite section's list
  // narrows to ZIPs paired with the selection (and the map switches to
  // pass-through flow rendering).
  // Shape mirrors selectedPartner — cities like Eagle/Grand Junction span
  // multiple ZIPs that all need to match for filtering, and the rolled-up
  // pass-through rows surface "{place} · multiple" entries that carry both.
  const [passThroughOrigin, setPassThroughOrigin] = useState<
    { place: string; zips: string[] } | null
  >(null);
  const [passThroughDest, setPassThroughDest] = useState<
    { place: string; zips: string[] } | null
  >(null);
  // When the user clicks empty map to dismiss both tooltips, the mouse may
  // still be over a corridor — without this guard, the next mousemove would
  // immediately re-show the simplified hover tooltip on the dismissed corridor.
  // The guard suppresses the hover tooltip for one specific corridor until the
  // user's mouse leaves it, at which point the suppression clears.
  const [suppressedHover, setSuppressedHover] = useState<CorridorId | null>(null);

  // Escape-key dismiss for the pinned tooltip. Listens at the document level
  // so the user can close the pinned panel from anywhere on the page without
  // having to target the small × button.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  // Track BottomCardStrip height so the credit chip can hover just above it.
  // Strip height changes with view type (aggregate / anchor / non-anchor) and
  // with segment-filter expansion, so a static offset can't keep the chip
  // pinned correctly across all states. Depends on `flowsInbound` because the
  // strip is gated behind a loading guard — the ref is null on first mount
  // and only populates after data resolves and the post-loading tree renders.
  useEffect(() => {
    const el = bottomStripRef.current;
    if (!el) return;
    const update = () => setBottomStripHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [flowsInbound]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${DATA_BASE}/flows-inbound.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/flows-outbound.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/zips.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/corridors.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/rac.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/wac.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/od-summary.json`).then((r) => r.json()),
      // Drive-distance is precomputed by scripts/build-drive-distance.py
      // against the public OSRM demo. Treat as optional — on a failed load the
      // mean-distance stat falls back to Haversine × detour-factor.
      fetch(`${DATA_BASE}/drive-distance.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      // Pass-through flows — optional. Built by scripts/build-passthrough.py
      // from the latest LODES year. When missing the Pass-Through Traffic
      // card simply doesn't render.
      fetch(`${DATA_BASE}/flows-passthrough.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      // Block-level OD — latest LODES year only, drives the heatmap layer.
      // Optional: on a failed load the heatmap layer is skipped silently.
      fetch(`${DATA_BASE}/od-blocks.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([fi, fo, z, cg, rac, wac, od, dd, pt, ob]: [
        FlowRow[],
        FlowRow[],
        ZipMeta[],
        CorridorGraph,
        RacFile,
        WacFile,
        OdSummaryFile,
        DriveDistanceMap | null,
        PassThroughFile | null,
        OdBlocksFile | null,
      ]) => {
        if (cancelled) return;
        // Guard against an old cached JSON (no per-pair segments block) —
        // the segment filter would silently no-op on those rows. Dev-only
        // warning; production builds skip the check.
        if (import.meta.env.DEV) {
          const missing = fi.find((f) => !f.segments) ?? fo.find((f) => !f.segments);
          if (missing) {
            console.warn(
              'flow rows are missing per-pair segment breakdowns — segment filter will be inactive. Re-run scripts/build-data.py.',
            );
          }
        }
        setFlowsInbound(fi);
        setFlowsOutbound(fo);
        setZips(z);
        setCorridorIndex(indexCorridors(cg));
        setFlowIndex(buildCorridorFlowIndex(fi, fo));
        setRacFile(rac);
        setWacFile(wac);
        setOdSummary(od);
        setDriveDistance(dd);
        setPassThrough(pt);
        setOdBlocks(ob);
      })
      .catch((err) => console.error('data load failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Regional flow union — deduped union of inbound + outbound. Powers the
  // synthetic 'regional' mode used in the aggregate (no-ZIP-selected) view.
  // Anchor↔anchor pairs collapse to a single row (identical workerCount and
  // segments in both build outputs); anchor→non-anchor and non-anchor→anchor
  // pairs each appear once. The result is the smallest correct universe of
  // flows that "touch at least one anchor."
  const flowsRegional = useMemo<FlowRow[] | null>(() => {
    if (!flowsInbound || !flowsOutbound) return null;
    return unionFlowsByPair(flowsInbound, flowsOutbound);
  }, [flowsInbound, flowsOutbound]);

  // effectiveMode = 'regional' when no ZIP is selected (aggregate view) so the
  // map / corridor pipeline draws the unioned universe. When a ZIP is selected
  // it falls back to the user-driven inbound/outbound mode. Raw `mode` is kept
  // around for the left panel and ModeToggle's button state.
  const effectiveMode: Mode =
    !selectedZip || selectedZip === 'ALL_OTHER' ? 'regional' : mode;

  const flows =
    effectiveMode === 'regional'
      ? flowsRegional
      : effectiveMode === 'inbound'
      ? flowsInbound
      : flowsOutbound;

  // Apply the direction filter to BOTH datasets up front. The aggregated
  // stats panel renders side-by-side inbound + outbound figures (Option B)
  // so both filtered sets are needed regardless of the active mode. The
  // map and per-ZIP stats still consume only the active-mode set.
  // The segment filter is then layered in — applySegmentFilter rewrites each
  // FlowRow's workerCount to the sum of the selected buckets within the
  // active axis, so every downstream consumer (corridor widths, stats panels,
  // card headlines) re-aggregates against the filtered universe with no
  // further plumbing. When the filter is inactive, the same array reference
  // is returned and downstream memoization stays stable.
  const directionFilteredInbound = useMemo(() => {
    if (!flowsInbound || !zips) return [];
    return applySegmentFilter(
      filterByDirection(flowsInbound, zips, directionFilter),
      segmentFilter,
    );
  }, [flowsInbound, zips, directionFilter, segmentFilter]);
  const directionFilteredOutbound = useMemo(() => {
    if (!flowsOutbound || !zips) return [];
    return applySegmentFilter(
      filterByDirection(flowsOutbound, zips, directionFilter),
      segmentFilter,
    );
  }, [flowsOutbound, zips, directionFilter, segmentFilter]);
  const directionFilteredRegional = useMemo(() => {
    if (!flowsRegional || !zips) return [];
    return applySegmentFilter(
      filterByDirection(flowsRegional, zips, directionFilter),
      segmentFilter,
    );
  }, [flowsRegional, zips, directionFilter, segmentFilter]);
  const directionFilteredFlows =
    effectiveMode === 'regional'
      ? directionFilteredRegional
      : effectiveMode === 'inbound'
      ? directionFilteredInbound
      : directionFilteredOutbound;

  // selectionKind drives every branch that needs to know "is this a real
  // anchor view vs the new non-anchor pivot vs aggregate". Derived from
  // selectedZip + ANCHOR_ZIPS so the source of truth stays in one place.
  const selectionKind: 'aggregate' | 'anchor' | 'non-anchor' = useMemo(() => {
    if (!selectedZip || selectedZip === 'ALL_OTHER') return 'aggregate';
    return isAnchorZip(selectedZip) ? 'anchor' : 'non-anchor';
  }, [selectedZip]);

  // Map-facing visible flows. For non-anchor selections the map keeps
  // showing the aggregate inbound network so the user has the full corridor
  // context around the highlighted bundle — the bundle's per-flow detail is
  // surfaced on the off-corridor branching layer (see `bundleFlows` below)
  // rather than narrowing the map to bundle-only corridors.
  const visibleFlows = useMemo(() => {
    if (selectionKind === 'non-anchor') {
      return directionFilteredInbound;
    }
    return filterForSelection(directionFilteredFlows, selectedZip, effectiveMode);
  }, [
    selectionKind,
    directionFilteredInbound,
    directionFilteredFlows,
    selectedZip,
    effectiveMode,
  ]);

  // Bundle-pivoted flows — one row per (bundle ZIP × anchor destination),
  // already aggregated by destination across the bundle's ZIPs. Drives the
  // non-anchor stats panels and the map's branching off-corridor layer.
  // Empty for anchor / aggregate selections.
  const bundleFlows = useMemo(() => {
    if (selectionKind !== 'non-anchor' || !nonAnchorBundle) return [];
    return detailForNonAnchorOrigin(
      directionFilteredInbound,
      nonAnchorBundle.zips,
    ).flows;
  }, [selectionKind, nonAnchorBundle, directionFilteredInbound]);

  // Mode-aware aggregation lifted up so the corridor legend (in
  // DashboardTile) and the renderer (MapCanvas) share one set of breaks.
  const visibleCorridorMap = useMemo(() => {
    if (!corridorIndex || !flowIndex) return null;
    return buildVisibleCorridorMap(corridorIndex, flowIndex, visibleFlows, effectiveMode);
  }, [corridorIndex, flowIndex, visibleFlows, effectiveMode]);

  // ----- Visual-only override (corridor + heatmap rendering) ----------------
  // In aggregate view the user can flip the ModeToggle to choose whether the
  // map paints inbound or outbound — the rest of the app (left panel, bottom
  // cards, tooltips, bucket-breaks scale) keeps consuming the union dataset
  // via `effectiveMode === 'regional'` so the underlying narrative stays
  // aggregated. Outside aggregate view these visual values fall through to
  // the canonical mode-driven values.
  const visualMode: Mode =
    selectionKind === 'aggregate' ? regionalViewMode : effectiveMode;
  const visualFlows: FlowRow[] | null =
    selectionKind === 'aggregate'
      ? regionalViewMode === 'inbound'
        ? flowsInbound
        : flowsOutbound
      : flows;
  const visualDirectionFiltered: FlowRow[] =
    selectionKind === 'aggregate'
      ? regionalViewMode === 'inbound'
        ? directionFilteredInbound
        : directionFilteredOutbound
      : directionFilteredFlows;
  const visualVisibleFlows = useMemo(() => {
    if (selectionKind === 'non-anchor') return directionFilteredInbound;
    return filterForSelection(
      visualDirectionFiltered,
      selectedZip,
      visualMode,
    );
  }, [
    selectionKind,
    directionFilteredInbound,
    visualDirectionFiltered,
    selectedZip,
    visualMode,
  ]);
  const visualVisibleCorridorMap = useMemo(() => {
    if (!corridorIndex || !flowIndex) return null;
    return buildVisibleCorridorMap(
      corridorIndex,
      flowIndex,
      visualVisibleFlows,
      visualMode,
    );
  }, [corridorIndex, flowIndex, visualVisibleFlows, visualMode]);

  // Heatmap GeoJSON — block-level OD density under the active filter set.
  // null when the layer should hide (non-anchor selection or unloaded data).
  // Mode is the visual override (regionalViewMode in aggregate view, the
  // canonical mode otherwise) so the heatmap responds to the regional-view
  // toggle alongside the corridor arcs.
  const heatmapData = useMemo(() => {
    if (!odBlocks || !zips) return null;
    return buildHeatmapGeoJson({
      odBlocks,
      zips,
      mode: visualMode,
      selectedZip,
      nonAnchorBundle,
      directionFilter,
      segmentFilter,
      selectedPartner,
    });
  }, [
    odBlocks,
    zips,
    visualMode,
    selectedZip,
    nonAnchorBundle,
    directionFilter,
    segmentFilter,
    selectedPartner,
  ]);

  // Selecting a non-anchor place drops the heatmap data to null upstream
  // (heatmapPoints returns null for non-anchor). If the user happened to be
  // in heatmap view at the moment of selection, force the toggle back to
  // corridor so they don't end up staring at an empty map. Heatmap remains
  // available — they can flip back manually after returning to anchor or
  // aggregate view.
  useEffect(() => {
    if (selectionKind === 'non-anchor') setViewLayer('corridor');
  }, [selectionKind]);

  // Reference distribution for the corridor width buckets — built from the
  // active mode's unfiltered flow set (ignoring direction filter and
  // selection) so the legend stays stable across All / East / West and
  // across ZIP selections. This is what makes stroke widths visually
  // comparable across views: a thick line means the same workers-per-
  // corridor count whether the user is filtered to East, West, or All.
  // Only the breaks are pinned to this reference; the renderer still
  // consumes the narrowed `visibleCorridorMap` to decide what to draw.
  const referenceCorridorMap = useMemo(() => {
    if (!corridorIndex || !flowIndex || !flows) return null;
    return buildVisibleCorridorMap(corridorIndex, flowIndex, flows, effectiveMode);
  }, [corridorIndex, flowIndex, flows, effectiveMode]);

  // Quantile breaks recomputed when mode changes. Inbound and outbound have
  // different distributions, so a single static break table won't do — but
  // within a mode the breaks are stable across direction filter.
  // Two break sets per mode:
  //   - aggregateBreaks (no ZIP selected): scaled to the full corridor-edge
  //     distribution (~9k headline corridors).
  //   - anchorBreaks (any ZIP selected): scaled to the per-anchor partition
  //     of those edges. Selecting one anchor only shows flows touching that
  //     ZIP, which carry far smaller totals; the aggregate scale would
  //     bucket every selected-view corridor as "quiet". Anchor breaks are
  //     computed from the union of per-corridor × per-anchor-zip partitions
  //     so the same scale applies whichever of the 11 anchors is picked.
  const aggregateBreaks = useMemo<[number, number, number, number]>(() => {
    if (!referenceCorridorMap) return [1, 2, 3, 4];
    const totals: number[] = [];
    for (const agg of referenceCorridorMap.values()) totals.push(agg.total);
    return computeBucketBreaks(totals);
  }, [referenceCorridorMap]);

  const anchorBreaks = useMemo<[number, number, number, number]>(() => {
    if (!referenceCorridorMap) return [1, 2, 3, 4];
    const totals: number[] = [];
    for (const agg of referenceCorridorMap.values()) {
      const byZip = mode === 'inbound' ? agg.byDestZip : agg.byOriginZip;
      for (const v of byZip.values()) totals.push(v);
    }
    return computeBucketBreaks(totals);
  }, [referenceCorridorMap, mode]);

  const bucketBreaks =
    selectedZip == null ? aggregateBreaks : anchorBreaks;

  // Top corridor for BOTH modes (direction-filtered, no selection narrowing).
  // Drives Option B's dual-rendered "Top corridor" tile in StatsAggregated,
  // which only renders when no ZIP is selected — so selection narrowing is
  // intentionally skipped here.
  const topCorridorInbound = useMemo<{ label: string; total: number } | null>(() => {
    if (!corridorIndex || !flowIndex) return null;
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, directionFilteredInbound, 'inbound');
    if (map.size === 0) return null;
    let best: ActiveCorridorAggregation | null = null;
    for (const agg of map.values()) if (!best || agg.total > best.total) best = agg;
    return best ? { label: best.corridor.label, total: best.total } : null;
  }, [corridorIndex, flowIndex, directionFilteredInbound]);

  const topCorridorOutbound = useMemo<{ label: string; total: number } | null>(() => {
    if (!corridorIndex || !flowIndex) return null;
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, directionFilteredOutbound, 'outbound');
    if (map.size === 0) return null;
    let best: ActiveCorridorAggregation | null = null;
    for (const agg of map.values()) if (!best || agg.total > best.total) best = agg;
    return best ? { label: best.corridor.label, total: best.total } : null;
  }, [corridorIndex, flowIndex, directionFilteredOutbound]);

  // Cross-ZIP flow counts for the direction-filter chip rendered in the
  // top-left map overlay. Math mirrors the inline chips that previously
  // lived in StatsAggregated (no anchor selected) and StatsForZip (anchor
  // selected) so the displayed "{n} of {d} flows shown" stays consistent
  // across views.
  const directionChipCounts = useMemo<{ numerator: number; denominator: number }>(() => {
    if (selectedZip == null) {
      const count = (rows: FlowRow[]) => {
        let n = 0;
        for (const f of rows) {
          if (f.originZip === f.destZip) continue;
          if (f.originZip === 'ALL_OTHER' || f.destZip === 'ALL_OTHER') continue;
          n += 1;
        }
        return n;
      };
      // Aggregate view shows the regional union on the map; the chip's
      // "X of Y flows shown" denominator/numerator follow the same universe.
      return {
        numerator: count(directionFilteredRegional),
        denominator: count(flowsRegional ?? []),
      };
    }
    if (selectionKind === 'non-anchor' && nonAnchorBundle && flowsInbound) {
      // Non-anchor pivot — count rows in the inbound dataset whose origin is
      // any ZIP in the bundle. detailForZip would always return 0 here since
      // it filters by destZip in inbound mode.
      const num = detailForNonAnchorOrigin(
        directionFilteredInbound,
        nonAnchorBundle.zips,
      ).flows.length;
      const den = detailForNonAnchorOrigin(
        flowsInbound,
        nonAnchorBundle.zips,
      ).flows.length;
      return { numerator: num, denominator: den };
    }
    const meta = zips?.find((z) => z.zip === selectedZip);
    if (!meta || !flows) return { numerator: 0, denominator: 0 };
    return {
      numerator: detailForZip(directionFilteredFlows, meta, mode).flows.length,
      denominator: detailForZip(flows, meta, mode).flows.length,
    };
  }, [
    selectedZip,
    selectionKind,
    nonAnchorBundle,
    zips,
    flows,
    mode,
    directionFilteredFlows,
    directionFilteredInbound,
    directionFilteredRegional,
    flowsInbound,
    flowsRegional,
  ]);

  // Pass-through cross-filter shares the lifecycle of the partner filter —
  // it scopes to a specific anchor + a residence/workplace pair, so any
  // change that invalidates the anchor context also invalidates it.
  const clearPassThrough = () => {
    setPassThroughOrigin(null);
    setPassThroughDest(null);
  };
  const handleModeChange = (m: Mode) => {
    // Defensive guard: when a non-anchor is selected the toggle is replaced
    // by an inline notice (no UI path to call this), but a stale ref could
    // still fire onModeChange. Ignore so we don't desync the lock.
    if (nonAnchorBundle) return;
    setHover(null);
    // Pinned tooltip is intentionally preserved across mode toggles. Its
    // aggregation is re-derived from the active mode's visibleCorridorMap
    // at render time so the breakdown stays in sync without dismissing the
    // panel out from under the user.
    setMode(m);
    // Partner selection is anchored to a specific anchor + mode + direction
    // context — clear it when any of those change so we don't carry an
    // orphaned partner across views where it wouldn't be visible.
    setSelectedPartner(null);
    clearPassThrough();
  };
  const handleSelectZip = (z: string | null) => {
    setHover(null);
    setPinned(null);
    setSelectedZip(z);
    setSelectedPartner(null);
    clearPassThrough();
    // Resolve the non-anchor place bundle. If z is null, ALL_OTHER, or an
    // anchor, clear the bundle. Otherwise gather every ZIP that shares the
    // clicked ZIP's place name so multi-ZIP places aggregate as one unit,
    // and force mode='inbound' so the toggle's underlying state is consistent
    // with the locked notice the user sees.
    if (!z || z === 'ALL_OTHER' || isAnchorZip(z)) {
      setNonAnchorBundle(null);
      return;
    }
    const meta = zips?.find((x) => x.zip === z);
    if (!meta) {
      setNonAnchorBundle(null);
      return;
    }
    const place = meta.place;
    const siblingZips = (zips ?? [])
      .filter((x) => x.place === place && !x.isSynthetic)
      .map((x) => x.zip)
      .sort();
    setNonAnchorBundle({ place, zips: siblingZips.length ? siblingZips : [z] });
    setMode('inbound');
  };
  const handleDirectionChange = (d: DirectionFilter) => {
    setHover(null);
    // Pinned tooltip persists across direction toggles — its aggregation is
    // re-derived from the filtered visibleCorridorMap on render.
    setDirectionFilter(d);
    setSelectedPartner(null);
    clearPassThrough();
  };
  const handleSelectPartner = (
    p: { place: string; zips: string[] } | null,
  ) => {
    setHover(null);
    setPinned(null);
    setSelectedPartner(p);
    clearPassThrough();
  };
  const handleSegmentFilterChange = (next: SegmentFilter) => {
    setHover(null);
    setPinned(null);
    setSegmentFilter(next);
  };
  const handlePassThroughOrigin = (
    sel: { place: string; zips: string[] } | null,
  ) => {
    setHover(null);
    setPinned(null);
    setPassThroughOrigin(sel);
    // Selecting a pass-through filter takes precedence over the partner
    // filter — they target different flow universes and shouldn't stack.
    setSelectedPartner(null);
  };
  const handlePassThroughDest = (
    sel: { place: string; zips: string[] } | null,
  ) => {
    setHover(null);
    setPinned(null);
    setPassThroughDest(sel);
    setSelectedPartner(null);
  };

  if (
    !flowsInbound ||
    !flowsOutbound ||
    !zips ||
    !corridorIndex ||
    !flowIndex ||
    !flows ||
    !visibleCorridorMap ||
    !racFile ||
    !wacFile ||
    !odSummary
  ) {
    return (
      <div className="min-h-screen w-full md:w-screen md:h-screen flex items-center justify-center">
        <div className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
          Loading flow data…
        </div>
      </div>
    );
  }

  const headerFor = (s: HoverState) =>
    `${s.aggregation.corridor.label} — ${fmtInt(s.aggregation.total)} workers`;
  // Per-card subheads. Residence card describes the origin fan-in; Workplace
  // card describes the destination fan-out. Both are derived from the same
  // aggregation so a corridor click renders both axes simultaneously.
  const subheadForDirection = (
    s: HoverState,
    direction: 'residence' | 'workplace',
  ) =>
    direction === 'residence'
      ? `Workers come from ${s.aggregation.byOriginZip.size} residence ZIP(s) through this segment`
      : `Workers travel through here to ${s.aggregation.byDestZip.size} work ZIP(s)`;
  // Partner filter is mode-aware: in inbound mode the partner is a residence
  // ZIP, in outbound mode it's a workplace ZIP. Only the matching card's rows
  // are clickable for partner filtering; the other card is informational.
  const partnerDirection: 'residence' | 'workplace' =
    mode === 'inbound' ? 'residence' : 'workplace';

  // Suppress the simplified hover chip when:
  //   (a) the user is hovering over the already-pinned corridor — the full
  //       pinned tooltip already covers it, a duplicate chip would be noise.
  //   (b) the user just dismissed the tooltip via empty-map click and hasn't
  //       moved off the dismissed corridor yet (suppressedHover guard).
  const showHover =
    hover &&
    (!pinned || hover.corridorId !== pinned.corridorId) &&
    hover.corridorId !== suppressedHover;

  return (
    <div className="min-h-screen w-full flex flex-col relative md:w-screen md:h-screen md:flex-row" style={{ background: 'var(--bg-base)' }}>
      <DashboardTile
        flows={flows}
        directionFilteredFlows={directionFilteredFlows}
        flowsInbound={flowsInbound}
        flowsOutbound={flowsOutbound}
        directionFilteredInbound={directionFilteredInbound}
        directionFilteredOutbound={directionFilteredOutbound}
        zips={zips}
        mode={mode}
        onModeChange={handleModeChange}
        viewMode={selectionKind === 'aggregate' ? regionalViewMode : mode}
        onViewModeChange={
          selectionKind === 'aggregate' ? setRegionalViewMode : handleModeChange
        }
        selectedZip={selectedZip}
        onSelectZip={handleSelectZip}
        selectionKind={selectionKind}
        nonAnchorBundle={nonAnchorBundle}
        visibleFlows={visibleFlows}
        bundleFlows={bundleFlows}
        selectedPartner={selectedPartner}
        onSelectPartner={handleSelectPartner}
        directionFilter={directionFilter}
        onDirectionChange={handleDirectionChange}
        viewLayer={viewLayer}
        onViewLayerChange={setViewLayer}
        bucketBreaks={bucketBreaks}
        topCorridorInbound={topCorridorInbound}
        topCorridorOutbound={topCorridorOutbound}
        driveDistance={driveDistance}
      />
      <main className="relative w-full md:flex-1">
        {/* Map area wrapper — gives the absolutely-positioned MapCanvas
            (position:absolute; inset:0) a sized ancestor on mobile so the
            BottomCardStrip can sit beneath it in document flow. On desktop
            the wrapper fills main (md:absolute md:inset-0), restoring the
            pre-mobile layout where overlays and the strip stack via z-index. */}
        <div className="relative w-full h-[80vh] md:h-auto md:absolute md:inset-0">
        <MapCanvas
          flows={visualFlows}
          zips={zips}
          visibleFlows={visualVisibleFlows}
          bundleFlows={bundleFlows}
          nonAnchorBundle={nonAnchorBundle}
          visibleCorridorMap={visualVisibleCorridorMap}
          bucketBreaks={bucketBreaks}
          selectedZip={selectedZip}
          selectedPartner={selectedPartner}
          mode={visualMode}
          onSelectZip={handleSelectZip}
          hoveredCorridorId={hover?.corridorId ?? null}
          onHoverCorridor={(corridorId, payload) => {
            if (!corridorId || !payload) {
              setHover(null);
              // Mouse left the corridor — clear any empty-click suppression
              // so the next hover (on this or any corridor) shows normally.
              setSuppressedHover(null);
              return;
            }
            setHover({ corridorId, ...payload });
          }}
          onClickCorridor={(corridorId, payload) => {
            setPinned({ corridorId, ...payload });
            // A click on a (different) corridor should never inherit a stale
            // suppression from a prior empty-click dismissal.
            setSuppressedHover(null);
          }}
          onClickEmpty={() => {
            setPinned(null);
            // If the mouse is still over a corridor, suppress its simplified
            // hover until the user moves off so the dismissal sticks.
            setSuppressedHover(hover?.corridorId ?? null);
          }}
          heatmapData={heatmapData}
          viewLayer={viewLayer}
        />

        {/* Block-level heatmap legend — bottom-left, above the bottom card
            strip and to the right of the left dashboard panel. Hidden when
            heatmapData is null (non-anchor selection / unloaded data). */}
        <HeatmapLegend
          mode={visualMode}
          selectedZip={selectedZip}
          zips={zips}
          segmentFilter={segmentFilter}
          visible={heatmapData != null && viewLayer === 'heatmap'}
          bottomOffset={bottomStripHeight + 16}
        />

        {/* Credit chip — docked to the right edge just above the bottom
            card strip. Strip height varies by view type (aggregate / anchor
            / non-anchor) and by segment-filter expansion; the chip's bottom
            edge sits 8px above the strip's top edge across all states. */}
        <div
          className="absolute right-4 glass rounded-md px-3 py-1.5 text-[11px] z-30 pointer-events-none"
          style={{
            color: 'var(--text-h)',
            bottom: bottomStripHeight + 8,
          }}
        >
          Created by Jacob Zook
        </div>

        {/* Active filter chips — pinned top-left of the map. */}
        <ActiveFiltersOverlay
          directionFilter={directionFilter}
          onClearDirection={() => handleDirectionChange('all')}
          selectedPartner={selectedPartner}
          onClearPartner={() => handleSelectPartner(null)}
          directionNumerator={directionChipCounts.numerator}
          directionDenominator={directionChipCounts.denominator}
          segmentFilter={segmentFilter}
          onClearSegmentFilter={() =>
            handleSegmentFilterChange({ axis: 'all', buckets: [] })
          }
        />

        {/* Region / Workplace export — top-right of the map. Renders for
            aggregate view (Region) and any anchor/non-anchor selection
            (Workplace). Hidden when no export is available. */}
        {(selectionKind === 'aggregate' || selectedZip) && (
          <div className="absolute top-2 right-2 md:top-3 md:right-4 z-30">
            <button
              type="button"
              onClick={() => {
                if (selectionKind === 'aggregate') {
                  if (!flowsInbound || !flowsOutbound || !zips || !corridorIndex || !flowIndex) return;
                  exportRegion({
                    flowsInbound,
                    flowsOutbound,
                    zips,
                    driveDistance,
                    racFile,
                    wacFile,
                    corridorIndex,
                    flowIndex,
                  });
                } else if (selectedZip) {
                  if (!flowsInbound || !flowsOutbound || !zips) return;
                  exportWorkplace({
                    selectedZip,
                    zips,
                    flowsInbound,
                    flowsOutbound,
                    racFile,
                    wacFile,
                    odSummary,
                    passThrough,
                    selectionKind,
                    nonAnchorBundle,
                  });
                }
              }}
              aria-label={selectionKind === 'aggregate' ? 'Region Export' : 'Workplace Export'}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-1"
              style={{
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                background: 'transparent',
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 2v9" />
                <path d="M4 7l4 4 4-4" />
                <path d="M2 13h12" />
              </svg>
              {selectionKind === 'aggregate' ? 'Region Export' : 'Workplace Export'}
            </button>
          </div>
        )}
        </div>
        {/* End map area wrapper. Pinned + hover tooltips below are position:fixed
            so they live outside the wrapper and don't affect document flow. The
            BottomCardStrip is a sibling — absolute bottom-0 of main on every
            viewport, so it overlays the bottom of the 60vh map on mobile and
            the full-height map on desktop. */}

        {/* Pinned tooltip — full breakdown, docked to the top-right of the
            map area so reading position stays stable (does not chase the
            click point). Persists until the user clicks another corridor,
            clicks the × close button, presses Escape, or clicks empty map.
            pointer-events: auto so the close button and clickable ZIP rows
            are interactive; the rest of the body is text-selectable. */}
        {pinned && (() => {
          // Re-derive the corridor's aggregation from the active mode +
          // direction filter's visibleCorridorMap so a mode/direction toggle
          // updates the pinned panel's content without dismissing it. If the
          // pinned corridor was filtered out (no visible flows under the new
          // filter state), fall back to the snapshot from click time so the
          // panel still has something to show until the user dismisses it.
          const liveAggregation =
            visibleCorridorMap.get(pinned.corridorId) ?? pinned.aggregation;
          const pinnedView: HoverState = { ...pinned, aggregation: liveAggregation };
          // Click handler shared by whichever card matches the active mode's
          // partner axis. In aggregate view (no anchor) partner filtering has
          // nothing to scope against, so rows are left informational.
          const partnerClickHandler = selectedZip
            ? (p: { place: string; zips: string[] }) => {
                const isSame = selectedPartner?.place === p.place;
                // Set partner state directly (rather than through
                // handleSelectPartner) so the pinned tooltip stays open and
                // the user can keep exploring the breakdown.
                setHover(null);
                setSelectedPartner(isSame ? null : p);
              }
            : undefined;
          return (
            <div
              className="fixed glass rounded-md px-3 py-2 text-[11px] z-50 top-12 left-2 right-2 md:top-[60px] md:right-4 md:left-auto md:w-[320px] max-h-[70vh] md:max-h-[calc(100vh-280px)] overflow-y-auto"
              role="dialog"
              aria-label="Corridor breakdown"
              style={{
                border: '1px solid var(--accent)',
              }}
            >
              {/* Panel header — corridor label, total, close button. */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div
                    className="text-[9px] font-semibold uppercase tracking-wider mb-0.5"
                    style={{ color: 'var(--accent)' }}
                  >
                    {selectedZip ? 'Pinned · click ZIP to filter' : 'Pinned'}
                  </div>
                  <span className="font-medium" style={{ color: 'var(--text-h)' }}>
                    {headerFor(pinnedView)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPinned(null)}
                  aria-label="Close pinned tooltip"
                  className="-mr-1 -mt-1 px-2 py-1 rounded text-xl hover:bg-white/10 shrink-0"
                  style={{ color: 'var(--text-h)', lineHeight: 1 }}
                >
                  ×
                </button>
              </div>

              {/* Card 1 — Places of Residence (origins, byOriginZip). */}
              <div
                className="rounded px-2 py-1.5 mb-2"
                style={{
                  background: 'var(--bg-card, rgba(255,255,255,0.03))',
                  border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
                }}
              >
                <div
                  className="text-[9px] font-semibold uppercase tracking-wider mb-0.5"
                  style={{ color: 'var(--text-h)' }}
                >
                  Places of Residence
                </div>
                <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                  {subheadForDirection(pinnedView, 'residence')}
                </div>
                <TooltipBody
                  aggregation={pinnedView.aggregation}
                  direction="residence"
                  zips={zips}
                  selectedPartner={selectedPartner}
                  onSelectPartner={
                    partnerDirection === 'residence' ? partnerClickHandler : undefined
                  }
                />
              </div>

              {/* Card 2 — Places of Work (destinations, byDestZip). */}
              <div
                className="rounded px-2 py-1.5"
                style={{
                  background: 'var(--bg-card, rgba(255,255,255,0.03))',
                  border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
                }}
              >
                <div
                  className="text-[9px] font-semibold uppercase tracking-wider mb-0.5"
                  style={{ color: 'var(--text-h)' }}
                >
                  Places of Work
                </div>
                <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                  {subheadForDirection(pinnedView, 'workplace')}
                </div>
                <TooltipBody
                  aggregation={pinnedView.aggregation}
                  direction="workplace"
                  zips={zips}
                  selectedPartner={selectedPartner}
                  onSelectPartner={
                    partnerDirection === 'workplace' ? partnerClickHandler : undefined
                  }
                />
              </div>

              <div className="mt-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                {pinnedView.aggregation.flows.length} flow
                {pinnedView.aggregation.flows.length === 1 ? '' : 's'} traverse this corridor
              </div>

              {/* Corridor export — bottom-right of the pinned tooltip. */}
              <div className="flex justify-end mt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!corridorIndex || !flowIndex || !flowsInbound || !flowsOutbound || !zips) return;
                    exportCorridor({
                      corridorId: pinnedView.corridorId,
                      corridorIndex,
                      flowIndex,
                      flowsInbound,
                      flowsOutbound,
                      zips,
                      mode: effectiveMode,
                      directionFilter,
                      selectedPartner,
                      passThroughOrigin,
                      passThroughDest,
                      selectedZip,
                      selectionKind,
                      nonAnchorBundle,
                    });
                  }}
                  aria-label="Corridor Export"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-1"
                  style={{
                    color: 'var(--accent)',
                    border: '1px solid var(--accent)',
                    background: 'transparent',
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M8 2v9" />
                    <path d="M4 7l4 4 4-4" />
                    <path d="M2 13h12" />
                  </svg>
                  Corridor Export
                </button>
              </div>
            </div>
          );
        })()}

        {/* Hover tooltip — single-line chip showing the corridor label and
            total workers. Edge-aware placement (clampTooltipAnchor) flips
            it above/left of the cursor near the right/bottom edges so it
            never clips. Hidden when hovering the already-pinned corridor —
            click the corridor for the full breakdown. */}
        {showHover && hover && (() => {
          const anchor = clampTooltipAnchor(hover.clientX, hover.clientY, 280, 48);
          return (
            <div
              className="fixed pointer-events-none glass rounded-md px-2.5 py-1.5 text-[11px] z-50 whitespace-nowrap"
              style={{
                left: anchor.left,
                top: anchor.top,
              }}
            >
              <div className="font-medium" style={{ color: 'var(--text-h)' }}>
                {headerFor(hover)}
              </div>
              <div
                className="text-[10px] italic mt-0.5"
                style={{ color: 'var(--accent)' }}
              >
                Click to view more +
              </div>
            </div>
          );
        })()}

        {/* Bottom card strip — aggregate vs per-anchor LODES panels */}
        <BottomCardStrip
          containerRef={bottomStripRef}
          racFile={racFile}
          wacFile={wacFile}
          odSummary={odSummary}
          selectedZip={selectedZip}
          selectionKind={selectionKind}
          nonAnchorBundle={nonAnchorBundle}
          visibleFlows={visibleFlows}
          bundleFlows={bundleFlows}
          selectedPartner={selectedPartner}
          mode={mode}
          flowsInbound={directionFilteredInbound}
          flowsOutbound={directionFilteredOutbound}
          zips={zips}
          corridorIndex={corridorIndex}
          flowIndex={flowIndex}
          driveDistance={driveDistance}
          segmentFilter={segmentFilter}
          onSegmentFilterChange={handleSegmentFilterChange}
          directionFilter={directionFilter}
          passThrough={passThrough}
          passThroughOrigin={passThroughOrigin}
          passThroughDest={passThroughDest}
          onPassThroughOriginChange={handlePassThroughOrigin}
          onPassThroughDestChange={handlePassThroughDest}
        />
      </main>
    </div>
  );
}
