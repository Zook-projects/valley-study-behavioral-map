// Pure function that converts the block-level OD JSON into a GeoJSON
// FeatureCollection of weighted points for the MapLibre heatmap layer.
//
// Filter pipeline (mirrors the ZIP-level pipeline in flowQueries.ts):
//   1. mode + selectedZip → pick the active block list
//        - regional view (no selection or ALL_OTHER) → union of every
//          anchor's workplaceBlocks
//        - anchor + inbound → that anchor's workplaceBlocks
//        - anchor + outbound → that anchor's homeBlocks
//        - non-anchor → null (caller hides the layer)
//   2. directionFilter → drop partner contributions whose bearing relative
//      to the block's containing-anchor centroid disagrees with the active
//      filter. Self-pairs (partner.zip === block.anchorZip) and ALL_OTHER
//      are dropped from non-'all' filters to mirror filterByDirection().
//   3. selectedPartner → keep only partners whose zip is in the partner's
//      member-zips set. Only reachable in anchor view.
//   4. segmentFilter → re-weight each surviving partner by the sum of
//      selected buckets within the active axis. When the filter is
//      inactive, partner.total is used directly.
// Step 1 is always required. Steps 2-4 short-circuit to a fast path that
// just reads block.total when no filter is active and no partner is set.

import type { AnchorBlock, BlockSegments, OdBlocksFile } from '../types/lodes';
import type {
  AgeBucket,
  DirectionFilter,
  Naics3Bucket,
  SegmentFilter,
  WageBucket,
  ZipMeta,
} from '../types/flow';
import { isSegmentFilterAll } from './flowQueries';

// Re-derive the same direction-classifier thresholds used by flowQueries —
// keeping them local rather than imported because flowQueries doesn't export
// classifyDirection (it's an internal helper to filterByDirection).
const EW_THRESHOLD_DEG = 0.005;
const NS_DOMINANCE_RATIO = 2;

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

/** Sum of the selected buckets within the active axis for a BlockSegments
 * (or BlockPartner — same shape) record. When the filter is inactive,
 * caller should use the record's `total` directly; this helper is only
 * called on the segment-filter-active branch. */
function segmentSumFromBlockSegments(
  seg: BlockSegments,
  filter: SegmentFilter,
): number {
  if (filter.axis === 'all' || filter.buckets.length === 0) return 0;
  let n = 0;
  if (filter.axis === 'age') {
    for (const b of filter.buckets) n += seg.age[b as AgeBucket] ?? 0;
    return n;
  }
  if (filter.axis === 'wage') {
    for (const b of filter.buckets) n += seg.wage[b as WageBucket] ?? 0;
    return n;
  }
  for (const b of filter.buckets) n += seg.naics3[b as Naics3Bucket] ?? 0;
  return n;
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
  mode: 'inbound' | 'outbound' | 'regional';
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
    selectedZip,
    nonAnchorBundle,
    directionFilter,
    segmentFilter,
    selectedPartner,
  } = args;

  if (!odBlocks) return null;
  // Non-anchor selection — heatmap hides entirely.
  if (nonAnchorBundle) return null;

  // Pick the active block list per the anchor / mode / selection rules.
  let blocks: AnchorBlock[];
  if (!selectedZip || selectedZip === 'ALL_OTHER') {
    // Regional view → union of every anchor's blocks on the chosen side.
    // Inbound / 'regional' → workplaceBlocks (where the valley's workers
    // *work*). Outbound → homeBlocks (where they *live*). Each block already
    // carries `anchorZip` so the direction filter resolves uniformly.
    const useHomes = mode === 'outbound';
    blocks = [];
    for (const anchor of Object.values(odBlocks.anchors)) {
      const list = useHomes ? anchor.homeBlocks : anchor.workplaceBlocks;
      for (const b of list) blocks.push(b);
    }
  } else {
    const anchor = odBlocks.anchors[selectedZip];
    if (!anchor) return null; // selectedZip is non-anchor → hide
    blocks = mode === 'outbound' ? anchor.homeBlocks : anchor.workplaceBlocks;
  }

  const segmentActive = !isSegmentFilterAll(segmentFilter);
  const directionActive = directionFilter !== 'all';
  const partnerActive = selectedPartner != null;
  const fastPath = !segmentActive && !directionActive && !partnerActive;

  // First, resolve every surviving block's raw weight under the active
  // filter set. We collect into a [block, weight] list so we can find the
  // scope-max afterward and normalize. The scope is the active block list
  // itself: regional view → max across all 11 anchors' workplaceBlocks;
  // anchor view → max within the selected anchor. That makes each feature's
  // normalized weight a "share of the densest block in the current view",
  // which lines up with the discrete-band choropleth semantics requested
  // (LEHD OnTheMap style) — band cutoffs at 20/40/60/80% of scope-max.
  type Resolved = { block: AnchorBlock; weight: number };
  const resolved: Resolved[] = [];

  if (fastPath) {
    for (const b of blocks) {
      if (b.total > 0) resolved.push({ block: b, weight: b.total });
    }
  } else {
    // Slow path — iterate partners under the active filter set.
    const zipMetaByZip = new Map<string, ZipMeta>();
    for (const z of zips) zipMetaByZip.set(z.zip, z);
    const partnerZips = selectedPartner
      ? new Set<string>(selectedPartner.zips)
      : null;

    for (const b of blocks) {
      let weight = 0;
      for (const p of b.partners) {
        if (partnerZips && !partnerZips.has(p.zip)) continue;
        if (directionActive) {
          const bearing = classifyPartnerBearing(b.anchorZip, p.zip, zipMetaByZip);
          if (bearing !== directionFilter) continue;
        }
        const value = segmentActive
          ? segmentSumFromBlockSegments(p, segmentFilter)
          : p.total;
        weight += value;
      }
      if (weight > 0) resolved.push({ block: b, weight });
    }
  }

  // Quintile binning — every surviving block is placed into one of 5 bands
  // by its rank within the active scope (region-wide in regional view,
  // anchor-wide in anchor view). Assigning bin centers 0.10 / 0.30 / 0.50 /
  // 0.70 / 0.90 lines them up cleanly with the heatmap-color step cutoffs
  // (0.20 / 0.40 / 0.60 / 0.80) so each quintile renders in its own
  // discrete white alpha level. Mirrors the LEHD OnTheMap choropleth-style
  // visual where every block registers in some band rather than collapsing
  // into a long tail under linear scope-max normalization.
  const sorted = resolved
    .map((r) => r.weight)
    .sort((a, b) => a - b);
  // Index of the lowest value strictly greater than `frac` of the
  // distribution — used as upper-edge cutoffs for bins 1..4.
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
    if (w <= t20) return 0.10;
    if (w <= t40) return 0.30;
    if (w <= t60) return 0.50;
    if (w <= t80) return 0.70;
    return 0.90;
  };

  const features: HeatmapPointFeature[] = [];
  for (const r of resolved) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.block.lng, r.block.lat] },
      properties: { weight: bandCenter(r.weight), block: r.block.block },
    });
  }
  return { type: 'FeatureCollection', features };
}
