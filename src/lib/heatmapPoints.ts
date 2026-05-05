// Pure function that converts the block-level OD JSON into a GeoJSON
// FeatureCollection of weighted points for the MapLibre heatmap layer.
//
// The heatmap is driven by TWO axes that resolve independently:
//   • mode          — inbound / outbound / regional (canonical state)
//   • heatmapSide   — workplace / residence (independent UI toggle)
//
// In aggregate view the canonical mode locks to 'regional' upstream, so only
// heatmapSide matters: workplace → union of every anchor's workplaceBlocks,
// residence → union of every anchor's homeBlocks.
//
// In anchor view (selectedZip = X) all four (mode × heatmapSide) combinations
// are reachable. Two of them render BLOCKS WITHIN X (same-side); the other
// two render BLOCKS WITHIN OTHER ANCHORS that pair with X (cross-anchor):
//
//   inbound  + workplace  → workplaceBlocks[X]                        (within X)
//   outbound + residence  → homeBlocks[X]                             (within X)
//   inbound  + residence  → ⋃ homeBlocks[A] where partner.zip == X    (cross-anchor)
//   outbound + workplace  → ⋃ workplaceBlocks[A] where partner.zip==X (cross-anchor)
//
// Cross-anchor mode also emits a ZIP-centroid fallback for non-anchor partner
// ZIPs (e.g. inbound+residence with anchor X surfaces non-anchor home ZIPs
// pulled from workplaceBlocks[X].partners). These render as a single point
// per ZIP at its centroid — coarse but the only signal we have for blocks
// outside the 11 anchors.
//
// Filter pipeline (mirrors the ZIP-level pipeline in flowQueries.ts):
//   1. mode + heatmapSide + selectedZip → pick blocks + cross-anchor scope
//   2. directionFilter → drop partner contributions whose bearing relative
//      to the block's containing-anchor centroid disagrees with the active
//      filter. Self-pairs and ALL_OTHER are dropped from non-'all' filters
//      to mirror filterByDirection().
//   3. selectedPartner → in same-side mode, narrows partners; in cross-anchor
//      mode, narrows the iterated anchors (and centroid fallback ZIPs) since
//      "partner" is already collapsed onto X.
//   4. segmentFilter → re-weight each surviving partner by the sum of
//      selected buckets within the active axis. When the filter is
//      inactive, partner.total is used directly.
// Steps 2-4 short-circuit to a fast path that just reads block.total when no
// filter is active, no partner is set, and no cross-anchor projection.

import type {
  AnchorBlock,
  BlockPartner,
  OdBlocksFile,
} from '../types/lodes';
import type {
  DirectionFilter,
  SegmentFilter,
  ZipMeta,
} from '../types/flow';
import {
  EW_THRESHOLD_DEG,
  NS_DOMINANCE_RATIO,
  isAnchorZip,
  isSegmentFilterAll,
  sumBucketsFromAllAxes,
} from './flowQueries';

export type HeatmapSide = 'workplace' | 'residence';

/** Classify the bearing of `partnerZip` relative to `anchorZip`'s centroid.
 * Mirrors classifyDirection() in flowQueries.ts:393–425, but operates on a
 * block→partner pair (anchor centroid as origin, partner ZIP centroid as
 * destination). Returns null for self-pairs, ALL_OTHER, or unknown ZIPs. */
function classifyPartnerBearing(
  anchorZip: string,
  partnerZip: string,
  zipMetaByZip: Map<string, ZipMeta>,
): 'east' | 'west' | 'neutral' | null {
  if (!anchorZip || !partnerZip) return null;
  if (partnerZip === 'ALL_OTHER' || anchorZip === 'ALL_OTHER') return null;
  if (partnerZip === anchorZip) return null;
  const o = zipMetaByZip.get(anchorZip);
  const d = zipMetaByZip.get(partnerZip);
  if (!o || !d || o.lat == null || o.lng == null || d.lat == null || d.lng == null) {
    return null;
  }
  const dLng = d.lng - o.lng;
  const dLat = d.lat - o.lat;
  const dx = dLng * Math.cos((o.lat * Math.PI) / 180);
  const dy = dLat;
  if (Math.abs(dx) < EW_THRESHOLD_DEG && Math.abs(dy) < EW_THRESHOLD_DEG) {
    return 'neutral';
  }
  if (Math.abs(dy) > Math.abs(dx) * NS_DOMINANCE_RATIO) return 'neutral';
  return dLng > 0 ? 'east' : 'west';
}

export interface HeatmapPointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { weight: number; block: string };
}

export interface HeatmapFeatureCollection {
  type: 'FeatureCollection';
  features: HeatmapPointFeature[];
}

export interface BuildHeatmapArgs {
  odBlocks: OdBlocksFile | null;
  zips: ZipMeta[];
  // Canonical inbound / outbound / regional mode. In aggregate view this is
  // 'regional' and only heatmapSide matters; in anchor view it determines
  // the partner side and (combined with heatmapSide) whether the heatmap
  // renders within-anchor or cross-anchor.
  mode: 'inbound' | 'outbound' | 'regional';
  // Independent heatmap-side toggle — drives which BLOCK collection (W or H)
  // is rendered. Decoupled from mode so all four combinations are reachable.
  heatmapSide: HeatmapSide;
  selectedZip: string | null;
  // Non-anchor selections never render the heatmap; this param is included
  // so callers can pass it through without conditional logic at the call site.
  nonAnchorBundle: { place: string; zips: string[] } | null;
  directionFilter: DirectionFilter;
  segmentFilter: SegmentFilter;
  selectedPartner: { place: string; zips: string[] } | null;
}

/**
 * Build the GeoJSON FeatureCollection for the heatmap layer. Returns null
 * when the heatmap should be hidden (non-anchor selection). Returns an
 * empty FeatureCollection when no blocks match (e.g., partner-filter zero
 * matches) so the layer can still render with no visible density.
 */
export function buildHeatmapGeoJson(
  args: BuildHeatmapArgs,
): HeatmapFeatureCollection | null {
  const {
    odBlocks,
    zips,
    mode,
    heatmapSide,
    selectedZip,
    nonAnchorBundle,
    directionFilter,
    segmentFilter,
    selectedPartner,
  } = args;

  if (!odBlocks) return null;
  // Non-anchor selection — heatmap hides entirely.
  if (nonAnchorBundle) return null;

  const isAggregate = !selectedZip || selectedZip === 'ALL_OTHER';
  const anchorEntry = !isAggregate ? odBlocks.anchors[selectedZip!] : null;
  // Selected ZIP is non-anchor — caller would normally have caught this via
  // nonAnchorBundle, but guard defensively so we never explode.
  if (!isAggregate && !anchorEntry) return null;

  // ----- Block list resolution + cross-anchor projection ---------------------
  // Same-side: blocks within the selected anchor (or all anchors in aggregate).
  // Cross-anchor: iterate blocks across anchors whose partner side carries the
  // selected anchor X; emit ZIP-centroid points for non-anchor partners.
  let blocks: AnchorBlock[];
  // When set, every block's partners are projected to the single ZIP X — the
  // heatmap reads "where did flows that touched X come from / go to" rather
  // than the block's full partner mix. Drives the cross-anchor combinations.
  let crossAnchorTargetZip: string | null = null;
  // ZIP centroid fallback rows for cross-anchor mode — one entry per
  // non-anchor partner ZIP found in X's opposite-side blocks.
  let centroidFallback: Array<{ partnerZip: string; partners: BlockPartner[] }> = [];

  if (isAggregate) {
    // Aggregate: union of every anchor's chosen-side blocks.
    const useHomes = heatmapSide === 'residence';
    blocks = [];
    for (const a of Object.values(odBlocks.anchors)) {
      const list = useHomes ? a.homeBlocks : a.workplaceBlocks;
      for (const b of list) blocks.push(b);
    }
  } else {
    const X = selectedZip!;
    // Anchor's "own side" under the active mode — inbound mode pivots around
    // X's workplaces, outbound mode around X's residences. Mode === 'regional'
    // is unreachable here (anchor view forces effectiveMode = mode), but fall
    // through harmlessly to workplace if it ever leaks.
    const xSide: HeatmapSide = mode === 'outbound' ? 'residence' : 'workplace';

    if (heatmapSide === xSide) {
      // Same-side — blocks within X.
      blocks =
        heatmapSide === 'workplace'
          ? anchorEntry!.workplaceBlocks
          : anchorEntry!.homeBlocks;
    } else {
      // Cross-anchor — iterate every anchor's heatmapSide list, project
      // partners onto X. selectedPartner (if set) narrows the iterated
      // anchors since the partner concept is collapsed onto X here; the
      // user's partner filter therefore operates on the BLOCK side instead
      // of the partner side in this branch.
      const useHomes = heatmapSide === 'residence';
      const partnerScopeAnchors = selectedPartner
        ? new Set(selectedPartner.zips)
        : null;
      blocks = [];
      for (const [aZip, a] of Object.entries(odBlocks.anchors)) {
        if (partnerScopeAnchors && !partnerScopeAnchors.has(aZip)) continue;
        const list = useHomes ? a.homeBlocks : a.workplaceBlocks;
        for (const b of list) blocks.push(b);
      }
      crossAnchorTargetZip = X;

      // Centroid fallback — non-anchor partner ZIPs from X's opposite list.
      // For inbound + residence: opposite is workplaceBlocks[X], partners are
      // h_zcta. We aggregate every non-anchor h_zcta into a centroid point.
      // For outbound + workplace: opposite is homeBlocks[X], partners are
      // w_zcta. Non-anchor w_zcta partners get centroid points.
      const oppositeList = useHomes
        ? anchorEntry!.workplaceBlocks
        : anchorEntry!.homeBlocks;
      const anchorZipSet = new Set(Object.keys(odBlocks.anchors));
      const fallbackAcc = new Map<string, BlockPartner[]>();
      for (const b of oppositeList) {
        for (const p of b.partners) {
          if (p.zip === 'ALL_OTHER') continue;
          if (anchorZipSet.has(p.zip)) continue;
          if (partnerScopeAnchors && !partnerScopeAnchors.has(p.zip)) continue;
          let arr = fallbackAcc.get(p.zip);
          if (!arr) {
            arr = [];
            fallbackAcc.set(p.zip, arr);
          }
          arr.push(p);
        }
      }
      for (const [pz, partners] of fallbackAcc) {
        centroidFallback.push({ partnerZip: pz, partners });
      }
    }
  }

  // ----- Filter setup --------------------------------------------------------
  const segmentActive = !isSegmentFilterAll(segmentFilter);
  const directionActive = directionFilter !== 'all';
  // Map valley-terminology values to their underlying east/west bearing for
  // the partner-bearing comparison. up-valley = east + anchor-workplace-only
  // (constraint applied below alongside the bearing check); down-valley = west.
  // The flow-arc layer also includes an eastern-I-70-residence path for
  // up-valley (see filterByDirection), but the heatmap doesn't render
  // non-anchor residences so the additive path collapses to the bearing
  // path here.
  const bearingTarget: 'east' | 'west' | null =
    directionFilter === 'up-valley' ? 'east' :
    directionFilter === 'down-valley' ? 'west' :
    directionFilter === 'east' || directionFilter === 'west' ? directionFilter :
    null;
  const upValleyAnchorWorkplace = directionFilter === 'up-valley';

  // Block-level partner filter. In cross-anchor mode it pins partners to
  // {X}; in same-side mode with a selectedPartner it pins to the partner's
  // member ZIPs. Otherwise null (no per-partner filtering needed).
  let blockPartnerFilter: Set<string> | null = null;
  if (crossAnchorTargetZip) {
    blockPartnerFilter = new Set([crossAnchorTargetZip]);
  } else if (selectedPartner) {
    blockPartnerFilter = new Set(selectedPartner.zips);
  }

  const fastPath =
    !segmentActive && !directionActive && blockPartnerFilter == null;

  type Resolved = { lat: number; lng: number; key: string; weight: number };
  const resolved: Resolved[] = [];

  const zipMetaByZip = new Map<string, ZipMeta>();
  for (const z of zips) zipMetaByZip.set(z.zip, z);

  // ----- Block-level resolution ---------------------------------------------
  if (fastPath) {
    for (const b of blocks) {
      if (b.total > 0)
        resolved.push({ lat: b.lat, lng: b.lng, key: b.block, weight: b.total });
    }
  } else {
    for (const b of blocks) {
      let weight = 0;
      for (const p of b.partners) {
        if (blockPartnerFilter && !blockPartnerFilter.has(p.zip)) continue;
        if (directionActive) {
          const bearing = classifyPartnerBearing(
            b.anchorZip,
            p.zip,
            zipMetaByZip,
          );
          if (bearing !== bearingTarget) continue;
          // up-valley: workplace must be anchor. When this block represents
          // workplaces (heatmapSide === 'workplace'), the partner IS the
          // workplace, so require it to be an anchor ZIP. When the partner
          // is a residence (heatmapSide === 'residence'), the workplace is
          // b.anchorZip which is anchor by construction.
          if (upValleyAnchorWorkplace && heatmapSide === 'workplace' && !isAnchorZip(p.zip)) continue;
        }
        const value = segmentActive
          ? sumBucketsFromAllAxes(p, segmentFilter)
          : p.total;
        weight += value;
      }
      if (weight > 0)
        resolved.push({ lat: b.lat, lng: b.lng, key: b.block, weight });
    }
  }

  // ----- ZIP-centroid fallback (cross-anchor mode only) ----------------------
  // Non-anchor partner ZIPs that the cross-anchor block iteration can't reach
  // (their workers' homes / workplaces are outside the 11 anchors and therefore
  // not present in any anchor's block list). One coarse point per ZIP at its
  // centroid, weighted by the summed partner count from X's opposite list.
  if (crossAnchorTargetZip && centroidFallback.length > 0) {
    for (const entry of centroidFallback) {
      const z = zipMetaByZip.get(entry.partnerZip);
      if (!z || z.lat == null || z.lng == null) continue;

      // Direction filter: bearing reference is X (every partner record in
      // entry.partners came from X's opposite-list blocks, which all share
      // anchorZip = X). Single bearing decision per fallback ZIP.
      if (directionActive) {
        const bearing = classifyPartnerBearing(
          crossAnchorTargetZip,
          entry.partnerZip,
          zipMetaByZip,
        );
        if (bearing !== bearingTarget) continue;
        // up-valley: cross-anchor centroid fallback only fires for non-anchor
        // partner ZIPs (see fallbackAcc filter excluding anchorZipSet). When
        // heatmapSide === 'workplace' those non-anchor partners ARE the
        // workplace and therefore violate the anchor-workplace constraint.
        if (upValleyAnchorWorkplace && heatmapSide === 'workplace') continue;
      }

      let weight = 0;
      for (const p of entry.partners) {
        const value = segmentActive
          ? sumBucketsFromAllAxes(p, segmentFilter)
          : p.total;
        weight += value;
      }
      if (weight > 0) {
        resolved.push({
          lat: z.lat,
          lng: z.lng,
          key: `zip:${entry.partnerZip}`,
          weight,
        });
      }
    }
  }

  // ----- Quintile binning (LEHD OnTheMap–style discrete bands) --------------
  // Every surviving point is placed into one of 5 bands by its rank within
  // the active scope. Bin centers 0.10 / 0.30 / 0.50 / 0.70 / 0.90 line up
  // with the heatmap-color step cutoffs (0.20 / 0.40 / 0.60 / 0.80) so each
  // quintile renders in its own discrete white alpha level.
  const sorted = resolved.map((r) => r.weight).sort((a, b) => a - b);
  const cutoffAt = (frac: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(frac * sorted.length));
    return sorted[idx];
  };
  const t20 = cutoffAt(0.2);
  const t40 = cutoffAt(0.4);
  const t60 = cutoffAt(0.6);
  const t80 = cutoffAt(0.8);
  const bandCenter = (w: number): number => {
    if (w <= t20) return 0.1;
    if (w <= t40) return 0.3;
    if (w <= t60) return 0.5;
    if (w <= t80) return 0.7;
    return 0.9;
  };

  const features: HeatmapPointFeature[] = [];
  for (const r of resolved) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { weight: bandCenter(r.weight), block: r.key },
    });
  }
  return { type: 'FeatureCollection', features };
}
