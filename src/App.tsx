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
import { filterByDirection, filterForSelection } from './lib/flowQueries';
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
              <span style={{ color: 'var(--text-dim)' }}>· {r.zips.join(', ')}</span>
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
  const [mode, setMode] = useState<Mode>('inbound');
  const [selectedZip, setSelectedZip] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${DATA_BASE}/flows-inbound.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/flows-outbound.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/zips.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/corridors.json`).then((r) => r.json()),
    ])
      .then(([fi, fo, z, cg]: [FlowRow[], FlowRow[], ZipMeta[], CorridorGraph]) => {
        if (cancelled) return;
        setFlowsInbound(fi);
        setFlowsOutbound(fo);
        setZips(z);
        setCorridorIndex(indexCorridors(cg));
        setFlowIndex(buildCorridorFlowIndex(fi, fo));
      })
      .catch((err) => console.error('data load failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const flows = mode === 'inbound' ? flowsInbound : flowsOutbound;

  // Apply the direction filter to the active mode dataset before any
  // selection-based narrowing. Stats and the renderer share this set.
  const directionFilteredFlows = useMemo(
    () => (flows && zips ? filterByDirection(flows, zips, directionFilter) : []),
    [flows, zips, directionFilter],
  );

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

  // Heaviest corridor edge in the active mode + direction filter — feeds the
  // "Top corridor" stat tile. Driven by the same aggregation the map renders,
  // so the dashboard number matches the thickest line on the canvas.
  const topCorridor = useMemo<{ label: string; total: number } | null>(() => {
    if (!visibleCorridorMap || visibleCorridorMap.size === 0) return null;
    let best: ActiveCorridorAggregation | null = null;
    for (const agg of visibleCorridorMap.values()) {
      if (!best || agg.total > best.total) best = agg;
    }
    return best ? { label: best.corridor.label, total: best.total } : null;
  }, [visibleCorridorMap]);

  const handleModeChange = (m: Mode) => {
    setHover(null);
    setMode(m);
  };
  const handleSelectZip = (z: string | null) => {
    setHover(null);
    setSelectedZip(z);
  };
  const handleDirectionChange = (d: DirectionFilter) => {
    setHover(null);
    setDirectionFilter(d);
  };

  if (
    !flowsInbound ||
    !flowsOutbound ||
    !zips ||
    !corridorIndex ||
    !flowIndex ||
    !flows ||
    !visibleCorridorMap
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
        zips={zips}
        mode={mode}
        onModeChange={handleModeChange}
        selectedZip={selectedZip}
        onSelectZip={handleSelectZip}
        directionFilter={directionFilter}
        onDirectionChange={handleDirectionChange}
        bucketBreaks={bucketBreaks}
        topCorridor={topCorridor}
      />
      <main className="flex-1 relative">
        <MapCanvas
          flows={flows}
          zips={zips}
          visibleFlows={visibleFlows}
          visibleCorridorMap={visibleCorridorMap}
          bucketBreaks={bucketBreaks}
          selectedZip={selectedZip}
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
          className="absolute bottom-4 right-4 glass rounded-md px-3 py-1.5 text-[11px] z-30 pointer-events-none"
          style={{ color: 'var(--text-h)' }}
        >
          Created by Jacob Zook
        </div>

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
      </main>
    </div>
  );
}
