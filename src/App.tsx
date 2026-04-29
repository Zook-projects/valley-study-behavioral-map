// App — top-level layout. Loads flows-inbound.json, flows-outbound.json,
// zips.json, and corridors.json on mount, owns selection + mode state, and
// composes DashboardTile + MapCanvas + the corridor hover tooltip.
//
// Mode is strictly exclusive: at any moment the map renders either inbound
// flows (workplace anchor's home-ZIP fan-in) or outbound flows (residence
// anchor's work-ZIP fan-out). The hover tooltip's aggregation, denominator,
// and label set follow the active mode.

import { useEffect, useMemo, useState } from 'react';
import { MapCanvas } from './components/MapCanvas';
import { DashboardTile } from './components/DashboardTile';
import { BottomCardStrip } from './components/BottomCardStrip';
import { ActiveFiltersOverlay } from './components/ActiveFiltersOverlay';
import type {
  ActiveCorridorAggregation,
  CorridorFlowEntry,
  CorridorGraph,
  CorridorId,
  CorridorRecord,
  DirectionFilter,
  FlowRow,
  Mode,
  ZipMeta,
} from './types/flow';
import type { OdSummaryFile, RacFile, WacFile } from './types/lodes';
import {
  detailForZip,
  filterByDirection,
  filterForSelection,
  type DriveDistanceMap,
} from './lib/flowQueries';
import {
  buildCorridorFlowIndex,
  buildVisibleCorridorMap,
  indexCorridors,
} from './lib/corridors';
import { computeBucketBreaks } from './lib/arcMath';
import { fmtInt, fmtPct } from './lib/format';

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
function TooltipBody({
  aggregation,
  mode,
  zips,
}: {
  aggregation: ActiveCorridorAggregation;
  mode: Mode;
  zips: ZipMeta[];
}) {
  const map = mode === 'outbound' ? aggregation.byDestZip : aggregation.byOriginZip;
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

  const TOP = 8;
  const top = rows.slice(0, TOP);
  const rest = rows.slice(TOP);
  const restCount = rest.reduce((s, r) => s + r.count, 0);

  return (
    <table className="w-full text-[11px] tnum mt-1">
      <tbody>
        {top.map((r) => (
          <tr key={r.place}>
            <td className="pr-2 align-baseline" style={{ color: 'var(--text-h)' }}>
              {r.place}{' '}
              <span style={{ color: 'var(--text-dim)' }}>· {r.zips.length > 1 ? 'multiple' : r.zips[0]}</span>
            </td>
            <td className="text-right pr-2" style={{ color: 'var(--text)' }}>
              {fmtInt(r.count)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(r.count / total)}
            </td>
          </tr>
        ))}
        {rest.length > 0 && (
          <tr>
            <td className="pr-2 align-baseline italic" style={{ color: 'var(--text-dim)' }}>
              + {rest.length} more {mode === 'outbound' ? 'destinations' : 'origins'}
            </td>
            <td className="text-right pr-2" style={{ color: 'var(--text)' }}>
              {fmtInt(restCount)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(restCount / total)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default function App() {
  const [flowsInbound, setFlowsInbound] = useState<FlowRow[] | null>(null);
  const [flowsOutbound, setFlowsOutbound] = useState<FlowRow[] | null>(null);
  const [zips, setZips] = useState<ZipMeta[] | null>(null);
  const [corridorIndex, setCorridorIndex] = useState<Map<CorridorId, CorridorRecord> | null>(null);
  const [flowIndex, setFlowIndex] = useState<Map<CorridorId, CorridorFlowEntry[]> | null>(null);
  const [racFile, setRacFile] = useState<RacFile | null>(null);
  const [wacFile, setWacFile] = useState<WacFile | null>(null);
  const [odSummary, setOdSummary] = useState<OdSummaryFile | null>(null);
  const [driveDistance, setDriveDistance] = useState<DriveDistanceMap | null>(null);
  const [mode, setMode] = useState<Mode>('inbound');
  const [selectedZip, setSelectedZip] = useState<string | null>(null);
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
  const [hover, setHover] = useState<HoverState | null>(null);

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
    ])
      .then(([fi, fo, z, cg, rac, wac, od, dd]: [
        FlowRow[],
        FlowRow[],
        ZipMeta[],
        CorridorGraph,
        RacFile,
        WacFile,
        OdSummaryFile,
        DriveDistanceMap | null,
      ]) => {
        if (cancelled) return;
        setFlowsInbound(fi);
        setFlowsOutbound(fo);
        setZips(z);
        setCorridorIndex(indexCorridors(cg));
        setFlowIndex(buildCorridorFlowIndex(fi, fo));
        setRacFile(rac);
        setWacFile(wac);
        setOdSummary(od);
        setDriveDistance(dd);
      })
      .catch((err) => console.error('data load failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const flows = mode === 'inbound' ? flowsInbound : flowsOutbound;

  // Apply the direction filter to BOTH datasets up front. The aggregated
  // stats panel renders side-by-side inbound + outbound figures (Option B)
  // so both filtered sets are needed regardless of the active mode. The
  // map and per-ZIP stats still consume only the active-mode set.
  const directionFilteredInbound = useMemo(
    () => (flowsInbound && zips ? filterByDirection(flowsInbound, zips, directionFilter) : []),
    [flowsInbound, zips, directionFilter],
  );
  const directionFilteredOutbound = useMemo(
    () => (flowsOutbound && zips ? filterByDirection(flowsOutbound, zips, directionFilter) : []),
    [flowsOutbound, zips, directionFilter],
  );
  const directionFilteredFlows =
    mode === 'inbound' ? directionFilteredInbound : directionFilteredOutbound;

  const visibleFlows = useMemo(
    () => filterForSelection(directionFilteredFlows, selectedZip, mode),
    [directionFilteredFlows, selectedZip, mode],
  );

  // Mode-aware aggregation lifted up so the corridor legend (in
  // DashboardTile) and the renderer (MapCanvas) share one set of breaks.
  const visibleCorridorMap = useMemo(() => {
    if (!corridorIndex || !flowIndex) return null;
    return buildVisibleCorridorMap(corridorIndex, flowIndex, visibleFlows, mode);
  }, [corridorIndex, flowIndex, visibleFlows, mode]);

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
    return buildVisibleCorridorMap(corridorIndex, flowIndex, flows, mode);
  }, [corridorIndex, flowIndex, flows, mode]);

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
      return {
        numerator: count(directionFilteredInbound),
        denominator: count(flowsInbound ?? []),
      };
    }
    const meta = zips?.find((z) => z.zip === selectedZip);
    if (!meta || !flows) return { numerator: 0, denominator: 0 };
    return {
      numerator: detailForZip(directionFilteredFlows, meta, mode).flows.length,
      denominator: detailForZip(flows, meta, mode).flows.length,
    };
  }, [
    selectedZip,
    zips,
    flows,
    mode,
    directionFilteredFlows,
    directionFilteredInbound,
    flowsInbound,
  ]);

  const handleModeChange = (m: Mode) => {
    setHover(null);
    setMode(m);
    // Partner selection is anchored to a specific anchor + mode + direction
    // context — clear it when any of those change so we don't carry an
    // orphaned partner across views where it wouldn't be visible.
    setSelectedPartner(null);
  };
  const handleSelectZip = (z: string | null) => {
    setHover(null);
    setSelectedZip(z);
    setSelectedPartner(null);
  };
  const handleDirectionChange = (d: DirectionFilter) => {
    setHover(null);
    setDirectionFilter(d);
    setSelectedPartner(null);
  };
  const handleSelectPartner = (
    p: { place: string; zips: string[] } | null,
  ) => {
    setHover(null);
    setSelectedPartner(p);
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
      <div className="w-screen h-screen flex items-center justify-center">
        <div className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
          Loading flow data…
        </div>
      </div>
    );
  }

  const tooltipHeader = hover
    ? `${hover.aggregation.corridor.label} — ${fmtInt(hover.aggregation.total)} workers`
    : '';

  const tooltipSubhead =
    mode === 'outbound'
      ? `Workers travel through here to ${
          hover ? hover.aggregation.byDestZip.size : 0
        } work ZIP(s)`
      : `Workers come from ${
          hover ? hover.aggregation.byOriginZip.size : 0
        } residence ZIP(s) through this segment`;

  return (
    <div className="w-screen h-screen flex relative" style={{ background: 'var(--bg-base)' }}>
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
        selectedZip={selectedZip}
        onSelectZip={handleSelectZip}
        selectedPartner={selectedPartner}
        onSelectPartner={handleSelectPartner}
        directionFilter={directionFilter}
        onDirectionChange={handleDirectionChange}
        bucketBreaks={bucketBreaks}
        topCorridorInbound={topCorridorInbound}
        topCorridorOutbound={topCorridorOutbound}
        driveDistance={driveDistance}
      />
      <main className="flex-1 relative">
        <MapCanvas
          flows={flows}
          zips={zips}
          visibleFlows={visibleFlows}
          visibleCorridorMap={visibleCorridorMap}
          bucketBreaks={bucketBreaks}
          selectedZip={selectedZip}
          selectedPartner={selectedPartner}
          mode={mode}
          onSelectZip={handleSelectZip}
          hoveredCorridorId={hover?.corridorId ?? null}
          onHoverCorridor={(corridorId, payload) => {
            if (!corridorId || !payload) {
              setHover(null);
              return;
            }
            setHover({ corridorId, ...payload });
          }}
        />

        {/* Credit chip */}
        <div
          className="absolute top-4 right-4 glass rounded-md px-3 py-1.5 text-[11px] z-30 pointer-events-none"
          style={{ color: 'var(--text-h)' }}
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
        />

        {/* Hover tooltip */}
        {hover && (
          <div
            className="fixed pointer-events-none glass rounded-md px-3 py-2 text-[11px] z-50"
            style={{
              left: hover.clientX + 14,
              top: hover.clientY + 14,
              maxWidth: 280,
            }}
          >
            <div className="mb-0.5" style={{ color: 'var(--text-h)' }}>
              <span className="font-medium">{tooltipHeader}</span>
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              {tooltipSubhead}
            </div>
            <TooltipBody aggregation={hover.aggregation} mode={mode} zips={zips} />
            <div className="mt-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>
              {hover.aggregation.flows.length} flow
              {hover.aggregation.flows.length === 1 ? '' : 's'} traverse this corridor
            </div>
          </div>
        )}

        {/* Bottom card strip — aggregate vs per-anchor LODES panels */}
        <BottomCardStrip
          racFile={racFile}
          wacFile={wacFile}
          odSummary={odSummary}
          selectedZip={selectedZip}
          selectedPartner={selectedPartner}
          mode={mode}
          flowsInbound={flowsInbound}
          flowsOutbound={flowsOutbound}
          zips={zips}
          corridorIndex={corridorIndex}
          flowIndex={flowIndex}
          driveDistance={driveDistance}
        />
      </main>
    </div>
  );
}
