// MapCanvas — MapLibre dark base + an SVG overlay rendering the corridor
// graph. Each corridor paints once as a smoothed multi-point path, with
// stroke width scaled to the aggregated worker count of every visible flow
// that traverses it.

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import { CORRIDOR_BUCKET_SEMANTIC, corridorStyle } from '../lib/arcMath';
import { flowIdOf } from '../lib/corridors';
import type {
  ActiveCorridorAggregation,
  CorridorId,
  CorridorRecord,
  FlowRow,
  Mode,
  ZipMeta,
} from '../types/flow';

interface Props {
  flows: FlowRow[];
  zips: ZipMeta[];
  visibleFlows: FlowRow[];          // filtered subset to draw
  visibleCorridorMap: Map<CorridorId, ActiveCorridorAggregation>;
  bucketBreaks: [number, number, number, number];
  selectedZip: string | null;
  // Optional secondary partner selection — when set the renderer fades
  // every corridor that doesn't carry a flow matching this partner zip set
  // paired with the active anchor (partner is on origin side in inbound,
  // destination side in outbound). The non-matching corridors stay drawn
  // (so the user can still see the network around the highlighted route)
  // but at the same dim opacity used for non-anchor corridors.
  selectedPartner: { place: string; zips: string[] } | null;
  mode: Mode;
  onSelectZip: (zip: string | null) => void;
  hoveredCorridorId: CorridorId | null;
  onHoverCorridor: (
    corridorId: CorridorId | null,
    payload?: { aggregation: ActiveCorridorAggregation; clientX: number; clientY: number },
  ) => void;
  // Corridor-click pins the full tooltip until the user clicks a different
  // corridor or an empty part of the map. The pinned state lives in App.tsx;
  // MapCanvas just notifies on each interaction.
  onClickCorridor: (
    corridorId: CorridorId,
    payload: { aggregation: ActiveCorridorAggregation; clientX: number; clientY: number },
  ) => void;
  onClickEmpty: () => void;
}

// CARTO Dark Matter style — open, no API key required.
const STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Hillshade feature flag — defaults to true. Set VITE_HILLSHADE_ENABLED=false
// to render the flat Dark Matter base for side-by-side comparison.
const HILLSHADE_ENABLED =
  import.meta.env.VITE_HILLSHADE_ENABLED !== 'false';

// AWS Open Data — Mapzen Terrain Tiles, terrarium-encoded, no key, global.
// (The MapLibre demo-tiles terrain endpoint covers only Switzerland and
// returns 404 for the Roaring Fork Valley.)
const HILLSHADE_DEM_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export function MapCanvas({
  flows,
  zips,
  visibleFlows,
  visibleCorridorMap,
  bucketBreaks,
  selectedZip,
  selectedPartner,
  mode,
  onSelectZip,
  hoveredCorridorId,
  onHoverCorridor,
  onClickCorridor,
  onClickEmpty,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Keep onClickEmpty fresh inside the init-once effect — that effect captures
  // its closures on first mount, so we deref the latest callback on each click
  // via this ref instead of re-binding the listener.
  const onClickEmptyRef = useRef(onClickEmpty);
  useEffect(() => {
    onClickEmptyRef.current = onClickEmpty;
  }, [onClickEmpty]);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Init MapLibre once ---------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      bounds: [
        [-108.45, 39.05],
        [-106.65, 39.85],
      ],
      fitBoundsOptions: { padding: { top: 40, right: 40, bottom: 40, left: 40 } },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    // Empty-map clicks clear any pinned tooltip. Corridor halos and ZIP nodes
    // get pointer-events: auto so their handlers fire first; only clicks that
    // miss them reach MapLibre's canvas and trigger this listener.
    map.on('click', () => onClickEmptyRef.current());

    // Boost road visibility — CARTO Dark Matter renders roads near-black.
    map.on('style.load', () => {
      const style = map.getStyle();
      if (!style?.layers) return;

      // Hillshade — adds mountain relief beneath labels and overlays. Tuned
      // to recede behind the warm-amber accent and the white default arcs.
      if (HILLSHADE_ENABLED && !map.getSource('terrain-dem')) {
        map.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: [HILLSHADE_DEM_TILES],
          tileSize: 256,
          encoding: 'terrarium',
          maxzoom: 15,
          attribution:
            '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen Terrain Tiles · multiple data sources</a>',
        });

        // Place hillshade beneath the first symbol (label) layer so place
        // names, road labels, and waterway labels remain crisp on top.
        // Falls back to 'water' if no symbol layer is present.
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

      for (const layer of style.layers) {
        if (layer.type !== 'line') continue;
        const id = layer.id;
        const isRoad =
          id.includes('road') ||
          id.includes('highway') ||
          id.includes('street') ||
          id.includes('motorway') ||
          id.includes('tunnel') ||
          id.includes('bridge');
        if (!isRoad) continue;
        const isMajor =
          id.includes('motorway') ||
          id.includes('major') ||
          id.includes('trunk') ||
          id.includes('primary') ||
          /road-1$|road-2$/.test(id);
        try {
          map.setPaintProperty(
            id,
            'line-color',
            isMajor ? '#5a4a30' : '#3a3530',
          );
          map.setPaintProperty(id, 'line-opacity', isMajor ? 0.95 : 0.7);
        } catch {
          /* layer may not accept these props — skip */
        }
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- Render corridors + centroids on every map move and on data change ---
  useEffect(() => {
    const map = mapRef.current;
    const svg = svgRef.current;
    if (!map || !svg) return;

    // Container-level snap-to-nearest mousemove (item 8). render() rebuilds
    // halos on every map move/resize; we swap this listener with the new
    // closure each render so it stays bound to the current haloLookup.
    let currentSnapMove: ((e: MouseEvent) => void) | null = null;

    const render = () => {
      const rect = map.getContainer().getBoundingClientRect();

      // Project each ZIP centroid to screen-space for node rendering.
      const projected = new Map<string, { x: number; y: number }>();
      for (const z of zips) {
        if (z.isSynthetic) continue;
        if (z.lat != null && z.lng != null) {
          const p = map.project([z.lng, z.lat]);
          projected.set(z.zip, { x: p.x, y: p.y });
        }
      }

      // Clear and redraw.
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
      svg.setAttribute('width', String(rect.width));
      svg.setAttribute('height', String(rect.height));

      const NS = 'http://www.w3.org/2000/svg';
      const defs = document.createElementNS(NS, 'defs');
      defs.innerHTML = `
        <filter id="amber-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.4" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      `;
      svg.appendChild(defs);

      // Group: corridors
      const arcGroup = document.createElementNS(NS, 'g');
      arcGroup.setAttribute('data-layer', 'arcs');
      svg.appendChild(arcGroup);

      // Group: nodes (drawn above corridors)
      const nodeGroup = document.createElementNS(NS, 'g');
      nodeGroup.setAttribute('data-layer', 'nodes');
      svg.appendChild(nodeGroup);

      // Group: labels (drawn above everything)
      const labelGroup = document.createElementNS(NS, 'g');
      labelGroup.setAttribute('data-layer', 'labels');
      svg.appendChild(labelGroup);

      // ---- Corridors ----
      // Sort so heavier corridors paint first; lighter corridors layer on top
      // and remain hover-targetable through the halo.
      const orderedCorridors: Array<[CorridorId, ActiveCorridorAggregation]> =
        Array.from(visibleCorridorMap.entries()).sort(
          (a, b) => b[1].total - a[1].total,
        );

      // When a partner is also selected, narrow the "selected" predicate so
      // only corridors carrying the partner→anchor (inbound) or anchor→partner
      // (outbound) flow stay bright; every other corridor falls into the
      // existing dim-on-selection bucket.
      const partnerZipSet = selectedPartner
        ? new Set(selectedPartner.zips)
        : null;
      const isCorridorSelected = (agg: ActiveCorridorAggregation): boolean => {
        if (!selectedZip) return false;
        for (const fr of agg.flows) {
          const anchorMatch =
            mode === 'inbound'
              ? fr.destZip === selectedZip
              : fr.originZip === selectedZip;
          if (!anchorMatch) continue;
          if (!partnerZipSet) return true;
          const partnerMatch =
            mode === 'inbound'
              ? partnerZipSet.has(fr.originZip)
              : partnerZipSet.has(fr.destZip);
          if (partnerMatch) return true;
        }
        return false;
      };

      const isAllOtherCorridor = (agg: ActiveCorridorAggregation): boolean =>
        agg.flows.some(
          (fr) => fr.originZip === 'ALL_OTHER' || fr.destZip === 'ALL_OTHER',
        );

      const hasSelection = selectedZip != null;

      // ---- Shared hover state for all corridor halos this render pass ----
      // - Hover delay (item 7): only the *first* tooltip appearance is
      //   delayed by ~100ms; subsequent corridor switches fire immediately.
      // - Re-anchor threshold (item 9): once a tooltip is open on a
      //   corridor, additional mousemoves on the same corridor only re-fire
      //   onHoverCorridor when the cursor has moved > 8px since the last
      //   reported position. Reduces tooltip jitter.
      let hoverTimer: number | null = null;
      let pendingHover:
        | { cid: CorridorId; agg: ActiveCorridorAggregation; x: number; y: number }
        | null = null;
      let activeCorridorId: CorridorId | null = null;
      let lastClientX = -9999;
      let lastClientY = -9999;

      const fireHover = (
        cid: CorridorId,
        agg: ActiveCorridorAggregation,
        x: number,
        y: number,
      ) => {
        if (cid === activeCorridorId) {
          const dx = x - lastClientX;
          const dy = y - lastClientY;
          if (dx * dx + dy * dy < 64) return; // 8px threshold (item 9)
        }
        activeCorridorId = cid;
        lastClientX = x;
        lastClientY = y;
        onHoverCorridor(cid, { aggregation: agg, clientX: x, clientY: y });
      };

      const scheduleHover = (
        cid: CorridorId,
        agg: ActiveCorridorAggregation,
        x: number,
        y: number,
      ) => {
        if (activeCorridorId != null) {
          fireHover(cid, agg, x, y);
          return;
        }
        pendingHover = { cid, agg, x, y };
        if (hoverTimer != null) return;
        hoverTimer = window.setTimeout(() => {
          hoverTimer = null;
          if (pendingHover) {
            const p = pendingHover;
            pendingHover = null;
            fireHover(p.cid, p.agg, p.x, p.y);
          }
        }, 100);
      };

      const clearHover = () => {
        if (hoverTimer != null) {
          window.clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        pendingHover = null;
        if (activeCorridorId != null) {
          activeCorridorId = null;
          lastClientX = -9999;
          lastClientY = -9999;
          onHoverCorridor(null);
        }
      };

      // Lookup so the container-level snap-to-nearest handler can resolve
      // a data-corridor-id back to its aggregation without re-walking the
      // visible-corridor map.
      const haloLookup = new Map<CorridorId, ActiveCorridorAggregation>();

      const buildPathD = (corridor: CorridorRecord): string => {
        if (!corridor.geometry.length) return '';
        const parts: string[] = [];
        for (let i = 0; i < corridor.geometry.length; i++) {
          const [lng, lat] = corridor.geometry[i];
          const p = map.project([lng, lat]);
          parts.push(`${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
        }
        return parts.join(' ');
      };

      for (const [corridorId, agg] of orderedCorridors) {
        const selected = isCorridorSelected(agg);
        const hover = hoveredCorridorId === corridorId;
        const dashed = isAllOtherCorridor(agg);
        const style = corridorStyle(agg.total, bucketBreaks, dashed);

        // Stroke color:
        //   - Aggregate view (no ZIP selected): amber for every corridor —
        //     matches the anchor-workplace flow color and lets width +
        //     opacity carry the worker-count encoding.
        //   - Selection view: amber for the selected/hovered corridors,
        //     monochrome luminance ramp for the rest so the selected anchor
        //     reads as the foreground.
        // Opacity preserves the dim-others-on-selection behavior; in the
        // resting state, the bucket's natural opacity carries the encoding.
        const isInteractive = selected || hover;
        const strokeColor =
          isInteractive || !hasSelection ? 'var(--accent)' : style.color;
        const baseOpacity = hasSelection
          ? selected
            ? 0.95
            : 0.08
          : style.opacity;

        const pathD = buildPathD(agg.corridor);
        if (!pathD) continue;

        // Hit halo — invisible, wide, captures pointer events on thin corridors.
        // Stroke-width 36 gives every corridor a generous hover/click target;
        // the visible path on top still renders at its bucket-derived width
        // (visuals unchanged). The visible path is set to pointer-events:none
        // below so clicks landing directly on the stroke fall through to this
        // halo's click handler — without that, the visible path's default
        // pointer-events:auto swallows the click and pin-on-click breaks in
        // every browser when the cursor is *on* the corridor itself.
        const halo = document.createElementNS(NS, 'path');
        halo.setAttribute('d', pathD);
        halo.setAttribute('fill', 'none');
        halo.setAttribute('stroke', 'transparent');
        halo.setAttribute('stroke-width', '36');
        halo.setAttribute('stroke-linecap', 'round');
        halo.setAttribute('stroke-linejoin', 'round');
        // Explicit pointer-events: stroke ensures the transparent stroke is
        // hit-testable by both event dispatch and document.elementsFromPoint
        // (used by the snap-to-nearest container handler below).
        halo.style.pointerEvents = 'stroke';
        halo.style.cursor = 'pointer';
        halo.dataset.corridorId = corridorId;
        haloLookup.set(corridorId, agg);
        const hoverEnter = (e: MouseEvent) =>
          scheduleHover(corridorId, agg, e.clientX, e.clientY);
        const hoverMove = (e: MouseEvent) =>
          scheduleHover(corridorId, agg, e.clientX, e.clientY);
        const hoverLeave = () => clearHover();
        const clickHandler = (e: MouseEvent) => {
          // Stop the click from propagating to MapLibre's canvas, which
          // otherwise fires onClickEmpty and clears the pin we just set.
          e.stopPropagation();
          onClickCorridor(corridorId, {
            aggregation: agg,
            clientX: e.clientX,
            clientY: e.clientY,
          });
        };
        // Touch support (item 12) — tapping a corridor pins its tooltip.
        // preventDefault stops the synthetic mouse click that follows the
        // touch from re-firing onClickCorridor (and avoids the 300ms tap
        // delay on some browsers).
        const touchHandler = (e: TouchEvent) => {
          const t = e.touches[0] ?? e.changedTouches[0];
          if (!t) return;
          e.preventDefault();
          e.stopPropagation();
          onClickCorridor(corridorId, {
            aggregation: agg,
            clientX: t.clientX,
            clientY: t.clientY,
          });
        };
        halo.addEventListener('mouseenter', hoverEnter as EventListener);
        halo.addEventListener('mousemove', hoverMove as EventListener);
        halo.addEventListener('mouseleave', hoverLeave);
        halo.addEventListener('click', clickHandler as EventListener);
        halo.addEventListener('touchstart', touchHandler as EventListener, {
          passive: false,
        });

        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', pathD);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', String(style.width));
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('opacity', String(baseOpacity));
        if (dashed) path.setAttribute('stroke-dasharray', '3 4');
        if (isInteractive) path.setAttribute('filter', 'url(#amber-glow)');
        // Pointer events on the visible stroke are routed through the
        // transparent halo behind it (appended just above). Without this the
        // visible path's default pointer-events:auto captures the click,
        // and since this path has no click handler the pin silently drops.
        path.style.pointerEvents = 'none';
        if (!prefersReducedMotion) {
          path.style.transition = 'opacity 220ms ease, stroke 220ms ease';
        }
        path.setAttribute('role', 'img');
        path.setAttribute(
          'aria-label',
          `${agg.corridor.label}: ${agg.total.toLocaleString()} workers across ` +
            `${agg.flows.length} ${mode === 'inbound' ? 'origin' : 'destination'} ` +
            `flow(s) in ${mode} mode (${CORRIDOR_BUCKET_SEMANTIC[style.bucket]} corridor)`,
        );

        arcGroup.appendChild(halo);
        arcGroup.appendChild(path);
      }

      // ---- Self-flow rings ----
      // Rings inherit the same bucket palette as corridors so the encoding
      // is consistent across primitives. Ring count/radius logic is
      // unchanged — only stroke color and opacity track the bucket.
      const visibleFlowIds = new Set(visibleFlows.map(flowIdOf));
      for (const f of flows) {
        if (f.originZip !== f.destZip) continue;
        if (!visibleFlowIds.has(flowIdOf(f))) continue;
        const c = projected.get(f.destZip);
        if (!c) continue;
        // When a partner is selected the within-anchor self-flow is no longer
        // part of the highlighted route (partner != anchor by definition), so
        // demote the ring back to the dim non-selected style.
        const isSelected = selectedZip === f.destZip && partnerZipSet == null;
        const r = 6 + Math.log1p(f.workerCount) * 1.4;
        const ringStyle = corridorStyle(f.workerCount, bucketBreaks);
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', String(c.x));
        ring.setAttribute('cy', String(c.y));
        ring.setAttribute('r', String(r));
        ring.setAttribute('fill', 'none');
        ring.setAttribute(
          'stroke',
          isSelected || !hasSelection ? 'var(--accent)' : ringStyle.color,
        );
        ring.setAttribute('stroke-width', '1');
        ring.setAttribute('opacity', String(isSelected ? 0.9 : ringStyle.opacity));
        if (isSelected) ring.setAttribute('filter', 'url(#amber-glow)');
        arcGroup.appendChild(ring);
      }

      // ---- ZIP centroid nodes ----
      type Rect = { x: number; y: number; w: number; h: number };
      const placedLabelRects: Rect[] = [];
      const charW = 5.6;
      const labelH = 12;
      const overlaps = (a: Rect, b: Rect) =>
        !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

      const nodeOrder = [...zips].sort((a, b) => {
        const aw = a.isSynthetic ? 0 : a.totalAsWorkplace;
        const bw = b.isSynthetic ? 0 : b.totalAsWorkplace;
        return bw - aw;
      });

      for (const z of nodeOrder) {
        const p = projected.get(z.zip);
        if (!p) continue;
        const isSelected = selectedZip === z.zip;
        const isAnchor = z.isAnchor;
        const isAllOther = z.isSynthetic;
        // Render only anchor workplaces and the synthetic All-Other node.
        // Non-anchor ZCTA centroids are routed through the corridor graph
        // (or rolled into ALL_OTHER) — they don't need their own dot.
        if (!isAnchor && !isAllOther) continue;
        const r = isAllOther
          ? 7
          : isAnchor
          ? 4 + Math.log1p(z.totalAsWorkplace) * 0.55
          : 1.8 + Math.log1p(z.totalAsResidence) * 0.35;

        if (isSelected) {
          const halo = document.createElementNS(NS, 'circle');
          halo.setAttribute('cx', String(p.x));
          halo.setAttribute('cy', String(p.y));
          halo.setAttribute('r', String(r + 6));
          halo.setAttribute('fill', 'var(--accent-soft)');
          halo.setAttribute('filter', 'url(#node-glow)');
          nodeGroup.appendChild(halo);
        }

        const node = document.createElementNS(NS, 'circle');
        node.setAttribute('cx', String(p.x));
        node.setAttribute('cy', String(p.y));
        node.setAttribute('r', String(r));
        node.setAttribute(
          'fill',
          isSelected ? 'var(--accent)' : isAnchor ? '#e6e8ee' : 'rgba(230,232,238,0.6)',
        );
        node.setAttribute('stroke', isSelected ? 'var(--accent)' : 'rgba(255,255,255,0.55)');
        node.setAttribute('stroke-width', isAnchor ? '1.2' : '0.6');
        node.style.cursor = isAnchor ? 'pointer' : 'default';
        if (!prefersReducedMotion) {
          node.style.transition = 'fill 200ms ease, r 200ms ease';
        }
        node.dataset.zip = z.zip;
        if (isAnchor) {
          node.setAttribute('role', 'button');
          node.setAttribute('tabindex', '0');
          node.setAttribute(
            'aria-label',
            `${z.place}, ZIP ${z.zip}, ${z.totalAsWorkplace.toLocaleString()} workers${isSelected ? ', selected' : ''}`,
          );
          node.setAttribute('aria-pressed', String(isSelected));
          const toggle = () => onSelectZip(selectedZip === z.zip ? null : z.zip);
          node.addEventListener('click', toggle);
          node.addEventListener('keydown', (e) => {
            const ke = e as KeyboardEvent;
            if (ke.key === 'Enter' || ke.key === ' ') {
              ke.preventDefault();
              toggle();
            }
          });
        }
        nodeGroup.appendChild(node);

        if (isAnchor || isAllOther) {
          const text = isAllOther ? 'All Other Locations' : z.place;
          const w = text.length * charW + 4;
          const pad = r + 5;
          const candidates: Array<{ x: number; y: number; anchor: 'start' | 'end' | 'middle' }> = [
            { x: p.x + pad, y: p.y + 3, anchor: 'start' },
            { x: p.x - pad, y: p.y + 3, anchor: 'end' },
            { x: p.x, y: p.y + r + labelH + 1, anchor: 'middle' },
            { x: p.x, y: p.y - r - 4, anchor: 'middle' },
          ];

          let chosen = candidates[0];
          let chosenRect: Rect | null = null;
          for (const c of candidates) {
            const rx =
              c.anchor === 'start'
                ? c.x
                : c.anchor === 'end'
                ? c.x - w
                : c.x - w / 2;
            const ry = c.y - labelH + 2;
            const rect: Rect = { x: rx, y: ry, w, h: labelH };
            if (!placedLabelRects.some((pr) => overlaps(rect, pr))) {
              chosen = c;
              chosenRect = rect;
              break;
            }
            if (!chosenRect) chosenRect = rect;
          }
          if (chosenRect) placedLabelRects.push(chosenRect);

          const label = document.createElementNS(NS, 'text');
          label.setAttribute('x', String(chosen.x));
          label.setAttribute('y', String(chosen.y));
          label.setAttribute('text-anchor', chosen.anchor);
          label.setAttribute('font-size', '10');
          label.setAttribute('font-weight', '500');
          label.setAttribute('fill', isSelected ? 'var(--accent)' : 'rgba(245,246,248,0.78)');
          label.setAttribute('font-family', 'Inter, system-ui, sans-serif');
          label.setAttribute('paint-order', 'stroke fill');
          label.setAttribute('stroke', 'rgba(8,9,12,0.85)');
          label.setAttribute('stroke-width', '2.5');
          label.setAttribute('stroke-linejoin', 'round');
          label.style.pointerEvents = 'none';
          label.style.letterSpacing = '0.2px';
          label.textContent = text;
          labelGroup.appendChild(label);
        }
      }

      // ---- Snap-to-nearest corridor on the map container (item 8) ----
      // Per-halo mouseenter/mousemove handles direct hits. This handler
      // covers the "cursor is *near* a thin corridor but not directly on
      // its 18px halo" case by ring-sampling document.elementsFromPoint at
      // ±8 and ±12 px around the cursor in 8 directions. First match wins.
      // Skips when a halo is directly under the cursor (those listeners
      // already fired). Clears the hover when the cursor moves into open
      // map space, so the snap doesn't keep a stale tooltip alive.
      const SNAP_OFFSETS: ReadonlyArray<readonly [number, number]> = [
        [8, 0], [-8, 0], [0, 8], [0, -8],
        [12, 0], [-12, 0], [0, 12], [0, -12],
        [8, 8], [8, -8], [-8, 8], [-8, -8],
        [12, 12], [12, -12], [-12, 12], [-12, -12],
      ];
      const container = map.getContainer();
      const snapMove = (e: MouseEvent) => {
        const direct = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of direct) {
          if ((el as HTMLElement).dataset?.corridorId) return;
        }
        for (const [dx, dy] of SNAP_OFFSETS) {
          const els = document.elementsFromPoint(e.clientX + dx, e.clientY + dy);
          for (const el of els) {
            const cid = (el as HTMLElement).dataset?.corridorId;
            if (!cid) continue;
            const aggMatch = haloLookup.get(cid);
            if (!aggMatch) continue;
            scheduleHover(cid, aggMatch, e.clientX, e.clientY);
            return;
          }
        }
        if (activeCorridorId != null) clearHover();
      };
      if (currentSnapMove) {
        container.removeEventListener('mousemove', currentSnapMove);
      }
      container.addEventListener('mousemove', snapMove);
      currentSnapMove = snapMove;
    };

    render();
    map.on('move', render);
    map.on('resize', render);
    map.on('load', render);

    return () => {
      map.off('move', render);
      map.off('resize', render);
      map.off('load', render);
      if (currentSnapMove) {
        map.getContainer().removeEventListener('mousemove', currentSnapMove);
        currentSnapMove = null;
      }
    };
  }, [
    flows,
    zips,
    visibleFlows,
    visibleCorridorMap,
    bucketBreaks,
    selectedZip,
    selectedPartner,
    mode,
    hoveredCorridorId,
    onSelectZip,
    onHoverCorridor,
    onClickCorridor,
    prefersReducedMotion,
  ]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <svg
        ref={svgRef}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      />
      <style>{`svg [data-layer="arcs"] path, svg [data-layer="nodes"] circle { pointer-events: auto; }`}</style>
    </div>
  );
}
