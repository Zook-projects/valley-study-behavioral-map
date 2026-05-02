// MapCanvas — MapLibre dark base + an SVG overlay rendering the corridor
// graph. Each corridor paints once as a smoothed multi-point path, with
// stroke width scaled to the aggregated worker count of every visible flow
// that traverses it.

import { useEffect, useRef } from 'react';
import maplibregl, {
  type GeoJSONSource,
  type Map as MLMap,
} from 'maplibre-gl';
import { CORRIDOR_BUCKET_SEMANTIC, corridorStyle } from '../lib/arcMath';
import { flowIdOf } from '../lib/corridors';
import { ANCHOR_ZIPS } from '../lib/flowQueries';
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
  // Bundle-pivoted flows for the non-anchor selection (origin in bundle.zips,
  // destination is an anchor). When non-empty, the off-corridor render layer
  // draws an organic branching tree from each origin to its anchor
  // destinations instead of falling back to the visibleFlows-minus-corridors
  // straggler heuristic. Empty for anchor / aggregate selections.
  bundleFlows: FlowRow[];
  // Non-anchor bundle (or null). When set, the map fits its viewport to the
  // union of the 11 anchor ZIP centroids + the bundle's ZIP centroids so
  // both the residence and the anchor workplaces are in frame.
  nonAnchorBundle: { place: string; zips: string[] } | null;
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
  // Heatmap data — workplace/residential block density, latest LODES year.
  // null hides the layer entirely (non-anchor selection or unloaded data).
  // Empty FeatureCollection keeps the layer visible but with no density.
  heatmapData: {
    type: 'FeatureCollection';
    features: Array<{
      type: 'Feature';
      geometry: { type: 'Point'; coordinates: [number, number] };
      properties: { weight: number; block: string };
    }>;
  } | null;
  // Active visualization layer — 'corridor' shows the SVG flow arcs and hides
  // the heatmap; 'heatmap' shows the heatmap and hides arcs / off-corridor
  // strands. ZIP nodes + labels remain visible in both modes so selection
  // still works in heatmap view.
  viewLayer: 'corridor' | 'heatmap';
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
  bundleFlows,
  nonAnchorBundle,
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
  heatmapData,
  viewLayer,
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

      // Hide every basemap symbol (label) layer — place names, road shields,
      // POI / water labels. The map's own ZIP-node labels remain (they live
      // in the SVG overlay, not the MapLibre style), so anchor identification
      // stays intact while the basemap goes silent behind the heatmap / arcs.
      for (const layer of style.layers) {
        if (layer.type !== 'symbol') continue;
        try {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        } catch {
          /* layer may already be hidden — skip */
        }
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

  // ---- Heatmap layer (block-level OD density) ------------------------------
  // Registers a single GeoJSON source + heatmap layer on style load. The
  // source data is updated by a sibling effect when `heatmapData` changes.
  // Layer is inserted before the first symbol layer so basemap labels stay
  // crisp on top; SVG flow arcs (rendered above the canvas) always paint
  // over the heatmap.
  const HEATMAP_SOURCE_ID = 'od-blocks-heatmap';
  const HEATMAP_LAYER_ID = 'od-blocks-heatmap-layer';
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ensureLayer = () => {
      if (map.getSource(HEATMAP_SOURCE_ID)) return;
      const style = map.getStyle();
      if (!style?.layers) return;
      map.addSource(HEATMAP_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      const firstSymbolLayerId =
        style.layers.find((l) => l.type === 'symbol')?.id;
      map.addLayer(
        {
          id: HEATMAP_LAYER_ID,
          type: 'heatmap',
          source: HEATMAP_SOURCE_ID,
          // Density is relative within the visible window; we don't cap the
          // weight expression so the densest block in the active filter set
          // always reaches the brightest stop.
          paint: {
            // Weight is pre-normalized to 0..1 in heatmapPoints.ts (each
            // block's worker count divided by the scope-max — region-wide
            // in regional view, anchor-wide in anchor view). Holding
            // intensity at 1 across all zooms keeps the density at a
            // kernel-center proportional to that normalized weight, so the
            // step bands in heatmap-color read as fixed % of scope-max
            // (≥20/40/60/80%) regardless of zoom.
            'heatmap-weight': ['get', 'weight'],
            // A larger radius is the key to producing the LEHD OnTheMap
            // contour-band look — adjacent block kernels need to overlap
            // heavily so the underlying density field is continuous, which
            // then lets the `step` color expression carve clean discrete
            // contour polygons through it. Small radii leave each block as
            // an isolated halo with band rings, which reads more like a
            // glow than the LEHD choropleth.
            // Exponential interpolation (base 2) keeps the kernel tight at
            // low zoom — at zoom 9 the radius is ~7px, at zoom 11 ~13px,
            // only at zoom 13–14 does it grow to the 40–70px range needed
            // for kernels to merge into LEHD-style contour bands. A flat
            // linear interpolation here over-smears the heatmap when the
            // user is zoomed out across the valley.
            'heatmap-radius': [
              'interpolate', ['exponential', 2], ['zoom'],
              8, 6,
              14, 70,
            ],
            // Intensity slightly above 1 lets quintile-binned weights (band
            // centers 0.10..0.90) push density above the top band cutoff
            // even when kernel falloff dilutes the peak — keeps the highest
            // quintile reading as the brightest band, not the second.
            'heatmap-intensity': 1.4,
            'heatmap-opacity': 0.85,
            // 5 discrete white bands — no gradient between stops. Mirrors
            // the LEHD OnTheMap discrete-choropleth heatmap style. MapLibre
            // accepts `step` expressions in heatmap-color, producing hard
            // edges between bands instead of smooth interpolation.
            'heatmap-color': [
              'step', ['heatmap-density'],
              'rgba(255,255,255,0)',     // density < 0.20 → transparent
              0.20, 'rgba(255,255,255,0.20)',
              0.40, 'rgba(255,255,255,0.45)',
              0.60, 'rgba(255,255,255,0.70)',
              0.80, 'rgba(255,255,255,0.95)',
            ],
          },
          layout: { visibility: 'none' },
        },
        firstSymbolLayerId,
      );
    };
    if (map.isStyleLoaded()) ensureLayer();
    map.on('style.load', ensureLayer);
    return () => {
      map.off('style.load', ensureLayer);
    };
  }, []);

  // Push heatmap data + visibility on every change. Keeping this in its own
  // effect lets the layer-registration effect run once while filter changes
  // only swap the source's GeoJSON without churning the layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource(HEATMAP_SOURCE_ID) as
        | GeoJSONSource
        | undefined;
      if (!src) return;
      if (heatmapData == null || viewLayer !== 'heatmap') {
        // Either no data, or the user has the corridor layer active. Keep
        // the source primed (empty) so the next show is instant.
        if (heatmapData == null) {
          src.setData({ type: 'FeatureCollection', features: [] });
        } else {
          src.setData(heatmapData);
        }
        if (map.getLayer(HEATMAP_LAYER_ID)) {
          map.setLayoutProperty(HEATMAP_LAYER_ID, 'visibility', 'none');
        }
        return;
      }
      src.setData(heatmapData);
      if (map.getLayer(HEATMAP_LAYER_ID)) {
        map.setLayoutProperty(HEATMAP_LAYER_ID, 'visibility', 'visible');
      }
    };
    if (map.isStyleLoaded() && map.getSource(HEATMAP_SOURCE_ID)) {
      apply();
    } else {
      // Wait for either the style or the layer-registration effect.
      map.once('idle', apply);
    }
  }, [heatmapData, viewLayer]);

  // ---- Fit bounds when a non-anchor bundle is selected ---------------------
  // Frame the bundle's ZIP centroids together with the 11 workplace anchors so
  // the user sees both ends of the residence → workplace commute. Skips when
  // any centroid is missing (synthetic ZIPs / unknown geography). When the
  // bundle clears (back to aggregate), the map flies back to the original
  // regional bounds so the user always returns to the same starting frame.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Branches:
    //   non-anchor selected → fit to bundle ZIPs ∪ ANCHOR_ZIPS (residence +
    //                         anchor workplaces both in frame).
    //   anchor selected     → flyTo the anchor's centroid at a tighter zoom
    //                         so the user can read the anchor's interior
    //                         (block heatmap or selection-narrowed arcs).
    //   aggregate / ALL_OTHER → fit back to the regional bounds used at
    //                          map init so deselection always returns the
    //                          user to the full-region frame.
    if (nonAnchorBundle) {
      const targetZips = new Set<string>([
        ...nonAnchorBundle.zips,
        ...ANCHOR_ZIPS,
      ]);
      const lats: number[] = [];
      const lngs: number[] = [];
      for (const z of zips) {
        if (!targetZips.has(z.zip)) continue;
        if (z.lat == null || z.lng == null) continue;
        lats.push(z.lat);
        lngs.push(z.lng);
      }
      if (lats.length < 2) return;
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        {
          padding: { top: 100, right: 100, bottom: 300, left: 100 },
          duration: 700,
          maxZoom: 9,
        },
      );
    } else if (selectedZip && ANCHOR_ZIPS.includes(selectedZip)) {
      // Zoom into the selected anchor — centroid + a fixed zoom that frames
      // the anchor's block-level structure (downtown core + surrounding
      // residential/employment fabric) without losing nearby context.
      const meta = zips.find((z) => z.zip === selectedZip);
      if (!meta || meta.lat == null || meta.lng == null) return;
      map.flyTo({
        center: [meta.lng, meta.lat],
        zoom: 11.5,
        duration: 700,
      });
    } else {
      // Aggregate / ALL_OTHER → restore the regional starting bounds.
      // Mirrors the init bounds + bottom padding for the card strip so the
      // restored view matches what the user first sees.
      map.fitBounds(
        [
          [-108.45, 39.05],
          [-106.65, 39.85],
        ],
        {
          padding: { top: 100, right: 100, bottom: 300, left: 100 },
          duration: 700,
          maxZoom: 9,
        },
      );
    }
  }, [nonAnchorBundle, selectedZip, zips]);

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

      // Group: off-corridor flows (rendered BELOW corridors so the curated
      // corridor network stays the dominant primitive). Used for any flow
      // that has no entry in visibleCorridorMap — typically non-anchor
      // bundle flows whose endpoints sit off the Hwy 82 / I-70 axis, plus
      // a small set of outlying anchor flows whose corridorPath was empty
      // at build time.
      const offCorridorGroup = document.createElementNS(NS, 'g');
      offCorridorGroup.setAttribute('data-layer', 'off-corridor');
      svg.appendChild(offCorridorGroup);

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
        // Stroke-width 64 gives every corridor a generous hover/click target
        // (~32px reach on each side of the centerline); the visible path on
        // top still renders at its bucket-derived width (visuals unchanged).
        // The visible path is set to pointer-events:none below so clicks
        // landing directly on the stroke fall through to this halo's click
        // handler — without that, the visible path's default
        // pointer-events:auto swallows the click and pin-on-click breaks in
        // every browser when the cursor is *on* the corridor itself.
        const halo = document.createElementNS(NS, 'path');
        halo.setAttribute('d', pathD);
        halo.setAttribute('fill', 'none');
        halo.setAttribute('stroke', 'transparent');
        halo.setAttribute('stroke-width', '64');
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
            `${agg.flows.length} ${
              mode === 'inbound' ? 'origin' : mode === 'outbound' ? 'destination' : 'OD pair'
            } ` +
            `flow(s) in ${mode} mode (${CORRIDOR_BUCKET_SEMANTIC[style.bucket]} corridor)`,
        );

        arcGroup.appendChild(halo);
        arcGroup.appendChild(path);
      }

      // ---- Off-corridor flows ----
      // Two sources feed this layer:
      //   1. When `bundleFlows` is non-empty (non-anchor selection) we draw
      //      a branching tree from each origin ZIP to every anchor it sends
      //      workers to. Branches share a near-origin "trunk" so the read
      //      is "this one place fans out to multiple anchors" rather than
      //      a bag of independent arcs.
      //   2. Otherwise we fall back to scanning visibleFlows for stragglers
      //      whose corridorPath was empty at build time, drawn as the same
      //      branching primitive (single-destination → single branch).
      // Self-flows are excluded in both cases — they keep their ring render.
      const corridorFlowIds = new Set<string>();
      for (const agg of visibleCorridorMap.values()) {
        for (const fr of agg.flows) corridorFlowIds.add(fr.flowId);
      }

      // Source-flow set: bundle flows when present, else off-corridor
      // stragglers from visibleFlows. Prevents double-rendering when a
      // bundle flow is also off-corridor.
      const sourceFlows: FlowRow[] = bundleFlows.length > 0
        ? bundleFlows.filter((f) => f.originZip !== f.destZip)
        : visibleFlows.filter(
            (f) =>
              f.originZip !== f.destZip &&
              !corridorFlowIds.has(flowIdOf(f)),
          );

      // Group by origin ZIP so each origin renders as one tree.
      const flowsByOrigin = new Map<string, FlowRow[]>();
      for (const f of sourceFlows) {
        const list = flowsByOrigin.get(f.originZip);
        if (list) list.push(f);
        else flowsByOrigin.set(f.originZip, [f]);
      }

      for (const [originZip, originFlows] of flowsByOrigin.entries()) {
        const o = projected.get(originZip);
        if (!o) continue;

        // Worker-weighted destination centroid — sets the "trunk direction"
        // out of the origin so every branch leaves in roughly the same
        // direction at first, then peels off toward its anchor.
        let cxSum = 0;
        let cySum = 0;
        let wSum = 0;
        const branches: Array<{ d: { x: number; y: number }; flow: FlowRow }> = [];
        for (const f of originFlows) {
          const d = projected.get(f.destZip);
          if (!d) continue;
          branches.push({ d, flow: f });
          cxSum += d.x * f.workerCount;
          cySum += d.y * f.workerCount;
          wSum += f.workerCount;
        }
        if (branches.length === 0 || wSum <= 0) continue;
        const cx = cxSum / wSum;
        const cy = cySum / wSum;

        // Junction point — 35% from origin toward weighted centroid. Sets
        // the shared "trunk" anchor. Branches all bend through the same
        // initial direction at the origin, giving the tree-like read.
        const jx = o.x + (cx - o.x) * 0.35;
        const jy = o.y + (cy - o.y) * 0.35;

        for (const { d, flow } of branches) {
          const ocStyle = corridorStyle(flow.workerCount, bucketBreaks);

          // Per-branch organic perpendicular jitter so two branches with
          // very similar destination vectors don't paint on top of each
          // other. Hash combines origin+dest so the jitter is stable
          // across renders.
          const hashStr = `${flow.originZip}|${flow.destZip}`;
          let hash = 0;
          for (let i = 0; i < hashStr.length; i++) {
            hash = (hash * 31 + hashStr.charCodeAt(i)) | 0;
          }
          const sign = hash & 1 ? 1 : -1;
          const dxJD = d.x - jx;
          const dyJD = d.y - jy;
          const lenJD = Math.sqrt(dxJD * dxJD + dyJD * dyJD) || 1;
          // Perpendicular offset for the second control point — small so
          // branches stay coherent but not identical chords.
          const perpFrac = 0.08 + ((Math.abs(hash) % 100) / 100) * 0.06;
          const px = -dyJD / lenJD;
          const py = dxJD / lenJD;

          // Cubic bezier:
          //   M  origin
          //   C  c1 = junction (shared trunk direction)
          //      c2 = approach toward dest with perpendicular bend
          //      end = dest
          // Pulling c2 partway back from dest toward the junction makes the
          // tail flare smoothly out of the trunk rather than kinking.
          const c2x = d.x - dxJD * 0.3 + px * lenJD * perpFrac * sign;
          const c2y = d.y - dyJD * 0.3 + py * lenJD * perpFrac * sign;

          const pathD =
            `M ${o.x.toFixed(1)} ${o.y.toFixed(1)} ` +
            `C ${jx.toFixed(1)} ${jy.toFixed(1)}, ` +
            `${c2x.toFixed(1)} ${c2y.toFixed(1)}, ` +
            `${d.x.toFixed(1)} ${d.y.toFixed(1)}`;

          // Hit halo — wide transparent stroke for hover/click target.
          const ocHalo = document.createElementNS(NS, 'path');
          ocHalo.setAttribute('d', pathD);
          ocHalo.setAttribute('fill', 'none');
          ocHalo.setAttribute('stroke', 'transparent');
          ocHalo.setAttribute('stroke-width', '20');
          ocHalo.setAttribute('stroke-linecap', 'round');
          ocHalo.setAttribute('stroke-linejoin', 'round');
          ocHalo.style.pointerEvents = 'stroke';
          ocHalo.style.cursor = 'default';
          const ocTitle = document.createElementNS(NS, 'title');
          ocTitle.textContent =
            `${flow.originPlace || flow.originZip} → ${flow.destPlace || flow.destZip}: ` +
            `${flow.workerCount.toLocaleString()} workers`;
          ocHalo.appendChild(ocTitle);
          offCorridorGroup.appendChild(ocHalo);

          const ocPath = document.createElementNS(NS, 'path');
          ocPath.setAttribute('d', pathD);
          ocPath.setAttribute('fill', 'none');
          ocPath.setAttribute('stroke', 'var(--accent)');
          ocPath.setAttribute('stroke-width', String(ocStyle.width));
          ocPath.setAttribute('stroke-linecap', 'round');
          ocPath.setAttribute('stroke-linejoin', 'round');
          // Dashed primitive distinguishes off-corridor branches from the
          // continuous corridor strokes — same visual language as the
          // existing dashed-arc highlight, scaled up for the longer branches
          // so the dash cadence reads as deliberate rather than noisy.
          ocPath.setAttribute('stroke-dasharray', '6 5');
          ocPath.setAttribute('opacity', '0.85');
          ocPath.style.pointerEvents = 'none';
          ocPath.setAttribute('role', 'img');
          ocPath.setAttribute(
            'aria-label',
            `${flow.originPlace || flow.originZip} to ${flow.destPlace || flow.destZip}: ` +
              `${flow.workerCount.toLocaleString()} workers, off-corridor flow`,
          );
          offCorridorGroup.appendChild(ocPath);
        }
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

      // ZIPs that belong to the active non-anchor bundle — they get a
      // temporary marker + place label so the residence side is visible
      // alongside the anchor workplaces. Empty set in anchor / aggregate
      // views, where only anchors and the synthetic ALL_OTHER node render.
      const bundleZipSet = nonAnchorBundle
        ? new Set(nonAnchorBundle.zips)
        : null;

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
        // Bundle ZIPs are rendered with the same marker + label primitive
        // as anchors so the non-anchor residence side reads as a peer of
        // the anchor workplaces in the same view.
        const isBundleMember = bundleZipSet?.has(z.zip) ?? false;
        // Render anchor workplaces, the synthetic All-Other node, and any
        // non-anchor ZIPs in the active bundle. Other non-anchor ZCTA
        // centroids are routed through the corridor graph and don't need
        // their own dot.
        if (!isAnchor && !isAllOther && !isBundleMember) continue;
        const r = isAllOther
          ? 7
          : isAnchor
          ? 2 + Math.log1p(z.totalAsWorkplace) * 0.275
          : isBundleMember
          ? 2 + Math.log1p(z.totalAsResidence) * 0.275
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

        if (isAnchor || isAllOther || isBundleMember) {
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
      // Per-halo mouseenter/mousemove handles direct hits inside the 64px
      // halo. This handler extends reach further by ring-sampling
      // document.elementsFromPoint at ±20 and ±32 px around the cursor in
      // 8 directions, so a cursor up to ~64 px from a corridor centerline
      // still triggers its tooltip. First match wins. Skips when a halo
      // is directly under the cursor (those listeners already fired).
      // Clears the hover when the cursor moves into open map space, so
      // the snap doesn't keep a stale tooltip alive.
      const SNAP_OFFSETS: ReadonlyArray<readonly [number, number]> = [
        [20, 0], [-20, 0], [0, 20], [0, -20],
        [32, 0], [-32, 0], [0, 32], [0, -32],
        [20, 20], [20, -20], [-20, 20], [-20, -20],
        [32, 32], [32, -32], [-32, 32], [-32, -32],
      ];
      const container = map.getContainer();
      const snapMove = (e: MouseEvent) => {
        const direct = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of direct) {
          if ((el as HTMLElement).dataset?.corridorId) return;
        }
        // Direct miss: if a corridor is already the active hover, clear it
        // immediately rather than letting the ring sample keep it alive in
        // open map space. The hover chip should be strictly tied to the
        // cursor being on a halo.
        if (activeCorridorId != null) {
          clearHover();
          return;
        }
        // No active hover yet — ring-sample to acquire hover on initial
        // approach to a nearby corridor.
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
    bundleFlows,
    nonAnchorBundle,
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
        data-view-layer={viewLayer}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      />
      {/* Pointer-events on the interactive arc + node geometry; nodes and
          labels remain visible in heatmap mode so the user can still pick a
          ZIP, but arcs and the off-corridor strands are hidden so the
          heatmap reads cleanly. */}
      <style>{`
        svg [data-layer="arcs"] path,
        svg [data-layer="nodes"] circle { pointer-events: auto; }
        svg[data-view-layer="heatmap"] [data-layer="arcs"],
        svg[data-view-layer="heatmap"] [data-layer="off-corridor"] { display: none; }
      `}</style>
    </div>
  );
}
