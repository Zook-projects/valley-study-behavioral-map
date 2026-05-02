// VisitorMapCanvas — Lean MapLibre + SVG overlay for the visitor view.
//
// Reuses the corridor graph from corridors.json + the same indexCorridors /
// buildVisibleCorridorMap pipeline as the commute view. Two render passes:
//
//   1. Corridors — stroke widths scale by aggregated visits (or visitors)
//      across every routable origin whose path traverses the corridor.
//
//   2. Origin dots — origins that bind nowhere on the corridor graph (the
//      long tail of out-of-state and non-CO-prefix ZIPs that have no
//      gateway fallback) render as graduated dots at their lat/lng. Hidden
//      at the Valley map scope so the local picture stays uncluttered;
//      surface only at State / National.
//
// The destination (Glenwood Springs) anchors the map. There is no anchor
// selector and no partner filter — the destination is fixed and corridor
// aggregation already yields a clean "where visitors come from" picture.

import { useEffect, useMemo, useRef } from 'react';
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import { corridorStyle } from '../../lib/arcMath';
import {
  buildVisibleCorridorMap,
  indexCorridors,
} from '../../lib/corridors';
import { fmtInt } from '../../lib/format';
import { MAP_SCOPE_BOUNDS } from '../../lib/placerQueries';
import type {
  CorridorGraph,
  CorridorId,
  CorridorRecord,
  FlowRow,
} from '../../types/flow';
import type {
  MapScope,
  PlacerZipMeta,
  VisitorFlowRow,
  VisitorMeasure,
} from '../../types/placer';

interface Props {
  // Already filtered + projected to FlowRow shape (see filterVisibleVisitorFlows).
  // The view owns scope/measure filtering; this component only renders.
  flows: FlowRow[];
  // Raw visitor rows for origin-dot rendering (off-graph origins — those
  // without a corridorPath, regardless of scope). These include lat/lng and
  // the active measure value, both needed for dot placement and sizing.
  visitorRows: VisitorFlowRow[];
  zips: PlacerZipMeta[];
  corridorGraph: CorridorGraph;
  measure: VisitorMeasure;
  mapScope: MapScope;
  // Selected origin ZIP from the dashboard list — when set, the matching
  // dot is amber and slightly larger. Null otherwise.
  selectedOrigin: string | null;
  onSelectOrigin: (zip: string | null) => void;
}

const STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const HILLSHADE_ENABLED =
  import.meta.env.VITE_HILLSHADE_ENABLED !== 'false';
const HILLSHADE_DEM_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const DEST_ZIP = '81601';

export function VisitorMapCanvas({
  flows,
  visitorRows,
  zips,
  corridorGraph,
  measure,
  mapScope,
  selectedOrigin,
  onSelectOrigin,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Indices over the corridor graph — built once, reused on every reproject.
  const corridorIndex = useMemo(
    () => indexCorridors(corridorGraph),
    [corridorGraph],
  );

  // Build the inverted index of (corridor → flow entries) for the visitor
  // dataset. We don't have an outbound counterpart here, so feed the same
  // array as both arguments — the visitor view always operates in
  // "regional"-equivalent semantics (single direction, no mode toggle).
  const flowIndex = useMemo(() => {
    // buildCorridorFlowIndex tags entries with direction; for visitors we
    // route everything as inbound and the renderer below uses 'inbound'
    // mode to aggregate. The second argument (outbound) is empty.
    const index = new Map<
      CorridorId,
      Array<{
        flowId: string;
        originZip: string;
        destZip: string;
        workerCount: number;
        direction: 'inbound' | 'outbound';
      }>
    >();
    for (const f of flows) {
      if (!f.corridorPath || f.corridorPath.length === 0) continue;
      const entry = {
        flowId: `${f.originZip}-${f.destZip}`,
        originZip: f.originZip,
        destZip: f.destZip,
        workerCount: f.workerCount,
        direction: 'inbound' as const,
      };
      for (const cid of f.corridorPath) {
        let bucket = index.get(cid);
        if (!bucket) {
          bucket = [];
          index.set(cid, bucket);
        }
        bucket.push(entry);
      }
    }
    return index;
  }, [flows]);

  const visibleCorridorMap = useMemo(
    () => buildVisibleCorridorMap(corridorIndex, flowIndex, flows, 'inbound'),
    [corridorIndex, flowIndex, flows],
  );

  // Quantile breaks for stroke widths over the visitor universe. Done once
  // per (flows, measure) — much smaller than LODES so cheap.
  const bucketBreaks = useMemo<[number, number, number, number]>(() => {
    const totals: number[] = [];
    for (const agg of visibleCorridorMap.values()) totals.push(agg.total);
    if (totals.length === 0) return [1, 2, 3, 4];
    const sorted = [...totals].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return [q(0.2), q(0.45), q(0.7), q(0.9)];
  }, [visibleCorridorMap]);

  // Off-graph origin rows for dot rendering. Any visitor row without a
  // corridorPath needs a dot — corridor-routed origins are already drawn
  // as edge strokes and would double-count if also dotted. Filter to rows
  // with a non-null measure value and a known lat/lng. Sort descending so
  // heavier dots paint first and lighter ones layer on top.
  const dotRows = useMemo(() => {
    const out: Array<{
      zip: string;
      place: string;
      lat: number;
      lng: number;
      value: number;
    }> = [];
    for (const r of visitorRows) {
      if (r.corridorPath && r.corridorPath.length > 0) continue;
      if (r.lat == null || r.lng == null) continue;
      const v = measure === 'visits' ? r.metrics.visits : r.metrics.visitors;
      if (v == null || v === 0) continue;
      out.push({
        zip: r.originZip,
        place: r.originPlace || r.originZip,
        lat: r.lat,
        lng: r.lng,
        value: v,
      });
    }
    out.sort((a, b) => b.value - a.value);
    return out;
  }, [visitorRows, measure]);

  const maxDotValue = dotRows.length > 0 ? dotRows[0].value : 1;

  // ---- Init MapLibre once ---------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      bounds: MAP_SCOPE_BOUNDS.valley,
      fitBoundsOptions: {
        padding: { top: 40, right: 40, bottom: 40, left: 40 },
      },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    map.on('style.load', () => {
      // Hillshade — same wiring as MapCanvas so the visitor view's terrain
      // matches the commute view's at the same zoom.
      const style = map.getStyle();
      if (!style?.layers) return;
      if (HILLSHADE_ENABLED && !map.getSource('terrain-dem')) {
        map.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: [HILLSHADE_DEM_TILES],
          tileSize: 256,
          encoding: 'terrarium',
          maxzoom: 15,
        });
        const firstSymbolLayerId =
          style.layers.find((l) => l.type === 'symbol')?.id ?? 'water';
        map.addLayer(
          {
            id: 'hillshade',
            source: 'terrain-dem',
            type: 'hillshade',
            paint: {
              'hillshade-shadow-color': '#000814',
              'hillshade-highlight-color': '#1a2330',
              'hillshade-accent-color': '#0a0f18',
              'hillshade-exaggeration': 0.55,
              'hillshade-illumination-direction': 315,
              'hillshade-illumination-anchor': 'viewport',
            },
          },
          firstSymbolLayerId,
        );
      }
      // Tone roads up a touch — Dark Matter renders them too dark over the
      // valley extent.
      for (const layer of style.layers) {
        if (layer.type !== 'line') continue;
        const id = layer.id;
        const isRoad =
          id.includes('road') ||
          id.includes('highway') ||
          id.includes('motorway');
        if (!isRoad) continue;
        try {
          map.setPaintProperty(id, 'line-color', '#3a3530');
          map.setPaintProperty(id, 'line-opacity', 0.7);
        } catch {
          /* ignore */
        }
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- React to mapScope changes -------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = MAP_SCOPE_BOUNDS[mapScope];
    map.fitBounds(bounds, {
      padding: { top: 40, right: 40, bottom: 40, left: 40 },
      duration: 750,
    });
  }, [mapScope]);

  // ---- Render SVG overlay on every map move/zoom ---------------------------
  useEffect(() => {
    const map = mapRef.current;
    const svg = svgRef.current;
    if (!map || !svg) return;

    const zipByCode = new Map<string, PlacerZipMeta>();
    for (const z of zips) zipByCode.set(z.zip, z);

    const render = () => {
      const rect = map.getContainer().getBoundingClientRect();
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
      svg.setAttribute('width', String(rect.width));
      svg.setAttribute('height', String(rect.height));
      const NS = 'http://www.w3.org/2000/svg';

      // ---- Corridors -----------------------------------------------------
      const arcGroup = document.createElementNS(NS, 'g');
      arcGroup.setAttribute('data-layer', 'arcs');
      svg.appendChild(arcGroup);

      // Sort heavier corridors first so lighter corridors stay on top.
      const ordered = Array.from(visibleCorridorMap.entries()).sort(
        (a, b) => b[1].total - a[1].total,
      );
      for (const [, agg] of ordered) {
        const corridor: CorridorRecord = agg.corridor;
        const points = corridor.geometry.map(([lng, lat]) =>
          map.project([lng, lat]),
        );
        if (points.length < 2) continue;
        const d = points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(' ');
        const style = corridorStyle(agg.total, bucketBreaks, false);
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', style.color);
        path.setAttribute('stroke-width', String(style.width));
        path.setAttribute('stroke-opacity', String(style.opacity));
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        const ariaLabel =
          `${corridor.label} — ${fmtInt(agg.total)} ${measure}`;
        path.setAttribute('aria-label', ariaLabel);
        path.setAttribute('role', 'img');
        arcGroup.appendChild(path);
      }

      // ---- Out-of-region origin dots -------------------------------------
      // Only at State / National scopes — Valley is too zoomed-in for a
      // long-tail dot map to read. We test by zoom rather than by stored
      // mapScope state so manual user pans (which don't update mapScope)
      // still hide/show the dots correctly.
      const dotGroup = document.createElementNS(NS, 'g');
      dotGroup.setAttribute('data-layer', 'dots');
      svg.appendChild(dotGroup);
      const zoom = map.getZoom();
      // Heuristic: valley extent peaks around zoom 8.5–9.5. Below ~7.5 we
      // start showing dots; below ~5.5 we show the full national set.
      const showDots = zoom < 7.8;
      if (showDots) {
        // Cap dots rendered to keep the SVG manageable. At national scope
        // we'd otherwise paint ~17k SVG circles.
        const limit = zoom < 5.5 ? 1500 : 600;
        for (let i = 0; i < dotRows.length && i < limit; i++) {
          const r = dotRows[i];
          const p = map.project([r.lng, r.lat]);
          if (
            p.x < -10 ||
            p.y < -10 ||
            p.x > rect.width + 10 ||
            p.y > rect.height + 10
          ) {
            continue;
          }
          // Square-root scale for area-proportional dots.
          const radius = 1.5 + 6 * Math.sqrt(r.value / Math.max(maxDotValue, 1));
          const isSelected = selectedOrigin === r.zip;
          const circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('cx', String(p.x.toFixed(1)));
          circle.setAttribute('cy', String(p.y.toFixed(1)));
          circle.setAttribute('r', String(isSelected ? radius + 1.5 : radius));
          circle.setAttribute(
            'fill',
            isSelected ? 'var(--accent)' : 'rgba(255, 255, 255, 0.45)',
          );
          circle.setAttribute(
            'stroke',
            isSelected ? 'var(--accent)' : 'rgba(255, 255, 255, 0.75)',
          );
          circle.setAttribute('stroke-width', '0.75');
          circle.setAttribute('aria-label', `${r.place} — ${fmtInt(r.value)} ${measure}`);
          circle.setAttribute('role', 'button');
          circle.style.cursor = 'pointer';
          circle.style.pointerEvents = 'auto';
          circle.addEventListener('click', (evt) => {
            evt.stopPropagation();
            onSelectOrigin(r.zip === selectedOrigin ? null : r.zip);
          });
          dotGroup.appendChild(circle);
        }
      }

      // ---- Destination marker (Glenwood Springs) -------------------------
      const dest = zipByCode.get(DEST_ZIP);
      if (dest && dest.lat != null && dest.lng != null) {
        const p = map.project([dest.lng, dest.lat]);
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', String(p.x.toFixed(1)));
        ring.setAttribute('cy', String(p.y.toFixed(1)));
        ring.setAttribute('r', '8');
        ring.setAttribute('fill', 'transparent');
        ring.setAttribute('stroke', 'var(--accent)');
        ring.setAttribute('stroke-width', '1.5');
        ring.setAttribute('stroke-opacity', '0.9');
        svg.appendChild(ring);
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(p.x.toFixed(1)));
        dot.setAttribute('cy', String(p.y.toFixed(1)));
        dot.setAttribute('r', '3.5');
        dot.setAttribute('fill', 'var(--accent)');
        svg.appendChild(dot);
        const label = document.createElementNS(NS, 'text');
        label.setAttribute('x', String((p.x + 12).toFixed(1)));
        label.setAttribute('y', String((p.y + 4).toFixed(1)));
        label.setAttribute('font-size', '11');
        label.setAttribute('fill', 'var(--text-h)');
        label.setAttribute('paint-order', 'stroke fill');
        label.setAttribute('stroke', 'var(--bg-base)');
        label.setAttribute('stroke-width', '3');
        label.setAttribute('stroke-linejoin', 'round');
        label.textContent = 'Glenwood Springs';
        svg.appendChild(label);
      }
    };

    render();
    map.on('move', render);
    map.on('zoom', render);
    map.on('resize', render);
    return () => {
      map.off('move', render);
      map.off('zoom', render);
      map.off('resize', render);
    };
  }, [
    visibleCorridorMap,
    bucketBreaks,
    dotRows,
    maxDotValue,
    measure,
    selectedOrigin,
    onSelectOrigin,
    zips,
  ]);

  return (
    <>
      {/* MapLibre forces this container's `position` to `relative` via its
          .maplibregl-map class, which neutralizes any `absolute inset-0`
          we try to set here. Use `w-full h-full` so the container fills
          its already-sized parent without depending on absolute insets —
          same pattern as the commute view's MapCanvas. */}
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ background: 'var(--bg-base)' }}
      />
      <svg
        ref={svgRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />
    </>
  );
}
