// VisitorView — top-level layout for the Placer.ai visitor dataset. Sibling
// of CommuteView; the App shell mounts whichever is active. The two views
// don't share state by design — they cover different conceptual universes
// (commuters vs visitors) with different filter semantics.
//
// Loads:
//   - placer-visitor-origins.json — flow rows with corridor paths
//   - placer-zips.json             — origin-side ZIP centroids + place metadata
//   - placer-summary.json          — destination rollup + top-N origin places
//   - corridors.json               — same corridor graph the commute view uses
//
// All four JSON files are emitted by the Python build pipeline; the visitor
// view never touches LODES outputs and the commute view never touches Placer
// outputs.

import { useEffect, useMemo, useRef, useState } from 'react';
import { VisitorMapCanvas } from '../components/visitors/VisitorMapCanvas';
import { VisitorDashboardTile } from '../components/visitors/VisitorDashboardTile';
import { VisitorBottomCardStrip } from '../components/visitors/VisitorBottomCardStrip';
import { MapScopeControl } from '../components/visitors/MapScopeControl';
import {
  filterVisibleVisitorFlows,
  totalsForScope,
} from '../lib/placerQueries';
import {
  buildVisibleCorridorMap,
  indexCorridors,
} from '../lib/corridors';
import type { CorridorGraph } from '../types/flow';
import type {
  MapScope,
  PlacerZipMeta,
  VisitorFlowRow,
  VisitorMeasure,
  VisitorScopeFilter,
  VisitorSummaryFile,
} from '../types/placer';
import type { Dataset } from '../types/dataset';
import { DatasetToggle } from '../components/DatasetToggle';

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

interface VisitorViewProps {
  // Top-level dataset selector state — owned by App.tsx and threaded in so
  // the DatasetToggle can be rendered inside this view's map area (anchored
  // to the map rather than fixed to the viewport, which prevents the toggle
  // from overlapping the full-width dashboard panel on mobile).
  dataset: Dataset;
  onDatasetChange: (next: Dataset) => void;
}

export function VisitorView({ dataset, onDatasetChange }: VisitorViewProps) {
  const [rows, setRows] = useState<VisitorFlowRow[] | null>(null);
  const [zips, setZips] = useState<PlacerZipMeta[] | null>(null);
  const [summary, setSummary] = useState<VisitorSummaryFile | null>(null);
  const [corridorGraph, setCorridorGraph] = useState<CorridorGraph | null>(null);

  const [measure, setMeasure] = useState<VisitorMeasure>('visits');
  const [scope, setScope] = useState<VisitorScopeFilter>('local');
  const [mapScope, setMapScope] = useState<MapScope>('valley');
  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null);

  const bottomStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${DATA_BASE}/placer-visitor-origins.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/placer-zips.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/placer-summary.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/corridors.json`).then((r) => r.json()),
    ])
      .then(([flows, z, s, cg]: [
        VisitorFlowRow[],
        PlacerZipMeta[],
        VisitorSummaryFile,
        CorridorGraph,
      ]) => {
        if (cancelled) return;
        setRows(flows);
        setZips(z);
        setSummary(s);
        setCorridorGraph(cg);
      })
      .catch((err) => console.error('placer data load failed', err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Derived datasets
  const visibleFlows = useMemo(() => {
    if (!rows) return [];
    return filterVisibleVisitorFlows(rows, measure, scope);
  }, [rows, measure, scope]);

  const totals = useMemo(() => {
    if (!rows) return { visits: 0, visitors: 0, originCount: 0 };
    return totalsForScope(rows, scope);
  }, [rows, scope]);

  // Top corridor under the active filter — recomputed locally rather than
  // pulled from summary.json since the active scope/measure changes which
  // corridor wins. Same buildVisibleCorridorMap helper the commute view
  // uses, fed visitor rows projected to FlowRow shape.
  const topCorridor = useMemo(() => {
    if (!corridorGraph) return { label: null as string | null, total: 0 };
    const corridorIndex = indexCorridors(corridorGraph);
    // Rebuild the corridor flow index over the visible flows. Cheap because
    // the visitor universe is small (~500 routable rows).
    const flowIndex = new Map<
      string,
      Array<{
        flowId: string;
        originZip: string;
        destZip: string;
        workerCount: number;
        direction: 'inbound' | 'outbound';
      }>
    >();
    for (const f of visibleFlows) {
      if (!f.corridorPath || f.corridorPath.length === 0) continue;
      const entry = {
        flowId: `${f.originZip}-${f.destZip}`,
        originZip: f.originZip,
        destZip: f.destZip,
        workerCount: f.workerCount,
        direction: 'inbound' as const,
      };
      for (const cid of f.corridorPath) {
        let bucket = flowIndex.get(cid);
        if (!bucket) {
          bucket = [];
          flowIndex.set(cid, bucket);
        }
        bucket.push(entry);
      }
    }
    const map = buildVisibleCorridorMap(
      corridorIndex,
      flowIndex,
      visibleFlows,
      'inbound',
    );
    let best: { label: string; total: number } | null = null;
    for (const agg of map.values()) {
      if (!best || agg.total > best.total) {
        best = { label: agg.corridor.label, total: agg.total };
      }
    }
    return { label: best?.label ?? null, total: best?.total ?? 0 };
  }, [corridorGraph, visibleFlows]);

  if (!rows || !zips || !summary || !corridorGraph) {
    return (
      <div
        className="min-h-screen w-full md:w-screen md:h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-base)' }}
      >
        <div
          className="text-xs uppercase tracking-widest"
          style={{ color: 'var(--text-dim)' }}
        >
          Loading visitor data…
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen w-full flex flex-col relative md:w-screen md:h-screen md:flex-row"
      style={{ background: 'var(--bg-base)' }}
    >
      <VisitorDashboardTile
        visitorRows={rows}
        measure={measure}
        onMeasureChange={setMeasure}
        scope={scope}
        onScopeChange={setScope}
        totalVisits={totals.visits}
        totalVisitors={totals.visitors}
        selectedOrigin={selectedOrigin}
        onSelectOrigin={setSelectedOrigin}
      />

      <main className="relative w-full md:flex-1">
        <div className="relative w-full h-[80vh] md:h-auto md:absolute md:inset-0">
          <VisitorMapCanvas
            flows={visibleFlows}
            visitorRows={rows}
            zips={zips}
            corridorGraph={corridorGraph}
            measure={measure}
            mapScope={mapScope}
            selectedOrigin={selectedOrigin}
            onSelectOrigin={setSelectedOrigin}
          />

          {/* Top-level dataset selector — anchored inside the map area
              so it never overlaps the full-width dashboard panel on
              mobile. Mobile: top-right of the map. Desktop: top-left of
              the map area. The MapScopeControl below shifts down on
              mobile only to clear room for the toggle stack; on desktop
              the two chips don't conflict (toggle is on the left). */}
          <div className="absolute top-2 right-2 md:right-auto md:left-2 md:top-3 z-40">
            <DatasetToggle dataset={dataset} onChange={onDatasetChange} />
          </div>

          {/* Map scope chips — top-right of the map on desktop; on mobile
              they tuck below the DatasetToggle to avoid overlap. */}
          <div className="absolute top-16 right-2 md:top-3 md:right-4 z-30">
            <MapScopeControl scope={mapScope} onChange={setMapScope} />
          </div>
        </div>

        <VisitorBottomCardStrip
          containerRef={bottomStripRef}
          visitorRows={rows}
          summary={summary}
          measure={measure}
          scope={scope}
          topCorridorLabel={topCorridor.label}
          topCorridorTotal={topCorridor.total}
        />
      </main>
    </div>
  );
}
