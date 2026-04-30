// Pure functions for inbound/outbound lookups across the FlowRow set.

import type {
  AgeBucket,
  Direction,
  DirectionFilter,
  FlowRow,
  Mode,
  Naics3Bucket,
  SegmentBucket,
  SegmentFilter,
  WageBucket,
  ZipMeta,
} from '../types/flow';
import type {
  AgeBlock,
  Naics3Block,
  OdLatest,
  OdTrend,
  TrendPoint,
  WageBlock,
} from '../types/lodes';

// Threshold below which a pair's E-W component is too small to call.
// 0.005° (longitude-corrected for latitude) keeps same-cluster pairs neutral
// without bleeding genuine valley-axis flows into 'neutral'.
const EW_THRESHOLD_DEG = 0.005;
// When the N-S component dominates the E-W component by this factor, the pair
// is treated as N-S (neutral) rather than as an east/west flow. Catches cases
// like Rifle→Meeker (mostly north) or Rifle→Montrose (mostly south) where the
// raw longitude sign would otherwise drag the flow into an east/west bucket.
const NS_DOMINANCE_RATIO = 2;

export const ANCHOR_ZIPS = [
  '81601', '81611', '81615', '81621', '81623',
  '81630', '81635', '81647', '81650', '81652', '81654',
];

/** True when zip is in the workplace anchor set. ALL_OTHER and unknown ZIPs return false. */
export function isAnchorZip(zip: string): boolean {
  return ANCHOR_ZIPS.includes(zip);
}

export interface AggregatedSummary {
  totalWorkers: number;
  crossZipShare: number;          // fraction of workers commuting across ZIP boundary
  topOutbound: FlowRow | null;    // highest-volume residence-ZIP origin overall
  allOtherShare: number;          // share of total mapped workers in ALL_OTHER bucket
}

export function computeAggregated(flows: FlowRow[]): AggregatedSummary {
  let total = 0;
  let selfFlow = 0;
  let allOther = 0;
  // For "top sender ZIP" we want the largest non-self flow whose origin is the
  // residence ZIP that sends the most workers in aggregate.
  let topOutbound: FlowRow | null = null;

  // Accumulate residence-ZIP totals to find the largest sender across the network.
  const senderTotals = new Map<string, number>();

  for (const f of flows) {
    total += f.workerCount;
    if (f.originZip === f.destZip) selfFlow += f.workerCount;
    // ALL_OTHER lives on the origin side for inbound flows and the destination
    // side for outbound flows — count either.
    if (f.originZip === 'ALL_OTHER' || f.destZip === 'ALL_OTHER') {
      allOther += f.workerCount;
    }

    if (f.originZip !== 'ALL_OTHER' && f.originZip !== f.destZip) {
      senderTotals.set(
        f.originZip,
        (senderTotals.get(f.originZip) ?? 0) + f.workerCount,
      );
    }
  }

  // Top outbound corridor — single flow with greatest worker count from the
  // dominant residence ZIP.
  let topSenderZip: string | null = null;
  let topSenderTotal = 0;
  for (const [zip, n] of senderTotals) {
    if (n > topSenderTotal) {
      topSenderTotal = n;
      topSenderZip = zip;
    }
  }
  if (topSenderZip) {
    for (const f of flows) {
      if (f.originZip === topSenderZip && f.originZip !== f.destZip) {
        if (!topOutbound || f.workerCount > topOutbound.workerCount) topOutbound = f;
      }
    }
  }

  return {
    totalWorkers: total,
    crossZipShare: total > 0 ? (total - selfFlow) / total : 0,
    topOutbound,
    allOtherShare: total > 0 ? allOther / total : 0,
  };
}

export interface ZipDetail {
  zip: ZipMeta;
  total: number;             // total inbound or outbound depending on mode
  flows: FlowRow[];          // sorted desc by workerCount, excludes self & ALL_OTHER
  selfFlow: number;          // within-ZIP commute count
  allOther: number;          // residual bucket count for this ZIP — origin-side
                             // 'ALL_OTHER' for inbound, destination-side for outbound
}

export function detailForZip(
  flows: FlowRow[],
  zip: ZipMeta,
  mode: Mode,
): ZipDetail {
  let total = 0;
  let selfFlow = 0;
  let allOther = 0;
  const out: FlowRow[] = [];

  for (const f of flows) {
    if (mode === 'inbound') {
      if (f.destZip !== zip.zip) continue;
      total += f.workerCount;
      if (f.originZip === f.destZip) {
        selfFlow += f.workerCount;
      } else if (f.originZip === 'ALL_OTHER') {
        allOther += f.workerCount;
      } else {
        out.push(f);
      }
    } else {
      // outbound: where do residents of `zip` work?
      if (f.originZip !== zip.zip) continue;
      total += f.workerCount;
      if (f.originZip === f.destZip) {
        selfFlow += f.workerCount;
      } else if (f.destZip === 'ALL_OTHER') {
        allOther += f.workerCount;
      } else {
        out.push(f);
      }
    }
  }

  out.sort((a, b) => b.workerCount - a.workerCount);
  return { zip, total, flows: out, selfFlow, allOther };
}

/**
 * For one or more non-anchor residence ZIPs (a "place bundle" that may
 * span multiple ZCTAs — e.g., Eagle 81631+81637, Grand Junction 81501+81505),
 * return the breakdown of workers across anchor workplaces using the inbound
 * dataset.
 *
 *   - originZips: array of ZIPs that share a place name. Single-element when
 *     the place maps to one ZIP.
 *   - Resulting flows are summed across the bundle and grouped by destination
 *     so each anchor appears at most once. workerCount is summed; segments
 *     are merged additively where present. originZip/originPlace on the
 *     returned rows are taken from the bundle (first member of `originZips`)
 *     so downstream consumers have a stable handle, but `total` reflects the
 *     full bundle aggregation.
 *   - selfFlow stays 0 (a non-anchor origin can't equal an anchor dest).
 *     allOther stays 0 (destinations are anchors only in the inbound dataset).
 */
export function detailForNonAnchorOrigin(
  flowsInbound: FlowRow[],
  originZips: string[],
): { total: number; flows: FlowRow[] } {
  const originSet = new Set(originZips);
  // Group by destination anchor so a multi-ZIP origin bundle collapses into
  // one row per anchor in the top-N list.
  const byDest = new Map<string, FlowRow>();
  let total = 0;

  for (const f of flowsInbound) {
    if (!originSet.has(f.originZip)) continue;
    total += f.workerCount;
    const existing = byDest.get(f.destZip);
    if (!existing) {
      // Clone so we can safely mutate workerCount/segments without polluting
      // the source array shared by the rest of the app.
      byDest.set(f.destZip, {
        ...f,
        // Keep originZip/originPlace as the bundle's primary handle. When
        // multi-ZIP, callers refer to the bundle directly via nonAnchorBundle.
        originZip: originZips[0],
        originPlace: f.originPlace,
        segments: f.segments
          ? {
              age: { ...f.segments.age },
              wage: { ...f.segments.wage },
              naics3: { ...f.segments.naics3 },
            }
          : undefined,
        // Per-pair corridorPath only makes sense for single OD rows; clear it
        // on the merged row so downstream corridor-routing code defers to the
        // off-corridor render path (which is what we want for non-anchor flows).
        corridorPath: f.corridorPath.slice(),
      });
    } else {
      existing.workerCount += f.workerCount;
      if (existing.segments && f.segments) {
        existing.segments.age.u29 += f.segments.age.u29;
        existing.segments.age.age30to54 += f.segments.age.age30to54;
        existing.segments.age.age55plus += f.segments.age.age55plus;
        existing.segments.wage.low += f.segments.wage.low;
        existing.segments.wage.mid += f.segments.wage.mid;
        existing.segments.wage.high += f.segments.wage.high;
        existing.segments.naics3.goods += f.segments.naics3.goods;
        existing.segments.naics3.tradeTransUtil += f.segments.naics3.tradeTransUtil;
        existing.segments.naics3.allOther += f.segments.naics3.allOther;
      }
    }
  }

  const flows = Array.from(byDest.values()).sort(
    (a, b) => b.workerCount - a.workerCount,
  );
  return { total, flows };
}

// Earth radius in miles — Haversine constant.
const EARTH_RADIUS_MI = 3958.7613;
// Detour multiplier applied to Haversine when no precomputed drive-distance is
// available. Empirically chosen for the Roaring Fork / Colorado River valley
// road network, which generally tracks the valley axis (Hwy 82, I-70).
const HAVERSINE_DETOUR_FACTOR = 1.25;

/** Drive-distance lookup, keyed `min(zipA,zipB)|max(zipA,zipB)`. */
export type DriveDistanceMap = Record<string, { miles: number; seconds: number }>;

/** Canonical key into a DriveDistanceMap — sorted to match the build script. */
export function driveDistanceKey(originZip: string, destZip: string): string {
  return originZip < destZip ? `${originZip}|${destZip}` : `${destZip}|${originZip}`;
}

/** Haversine great-circle distance in miles between two centroids. */
function haversineMiles(
  lat1Deg: number,
  lng1Deg: number,
  lat2Deg: number,
  lng2Deg: number,
): number {
  const lat1 = (lat1Deg * Math.PI) / 180;
  const lat2 = (lat2Deg * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((lng2Deg - lng1Deg) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Worker-weighted mean commute distance in miles across all cross-ZIP flows.
 * Self-flows and ALL_OTHER endpoints are excluded (no meaningful or available
 * distance).
 *
 * Distance source priority per pair:
 *   1. Precomputed OSRM drive-distance from `driveDistance` (road miles).
 *   2. Haversine × HAVERSINE_DETOUR_FACTOR fallback when the pair is missing
 *      from the map (e.g., centroid-only flows that weren't precomputed).
 *
 * Pass `undefined` for `driveDistance` to disable the lookup and fall back to
 * pure Haversine × detour-factor for every pair.
 */
export function meanCommuteMiles(
  flows: FlowRow[],
  zips: ZipMeta[],
  driveDistance?: DriveDistanceMap,
): number {
  const zipIndex = new Map<string, ZipMeta>();
  for (const z of zips) zipIndex.set(z.zip, z);

  let weightedMiles = 0;
  let weight = 0;
  for (const f of flows) {
    if (f.originZip === f.destZip) continue;
    if (f.originZip === 'ALL_OTHER' || f.destZip === 'ALL_OTHER') continue;

    let miles: number | null = null;
    if (driveDistance) {
      const hit = driveDistance[driveDistanceKey(f.originZip, f.destZip)];
      if (hit) miles = hit.miles;
    }
    if (miles == null) {
      const o = zipIndex.get(f.originZip);
      const d = zipIndex.get(f.destZip);
      if (!o || !d) continue;
      if (o.lat == null || o.lng == null || d.lat == null || d.lng == null) continue;
      miles = haversineMiles(o.lat, o.lng, d.lat, d.lng) * HAVERSINE_DETOUR_FACTOR;
    }

    weightedMiles += miles * f.workerCount;
    weight += f.workerCount;
  }
  return weight > 0 ? weightedMiles / weight : 0;
}

/**
 * Classify an O-D pair by geographic bearing using both axes.
 * Returns 'neutral' for self-flows, ALL_OTHER endpoints, missing centroids,
 * same-cluster pairs (both components small), and pairs where the N-S
 * component dominates the E-W component (predominantly meridional moves).
 * Otherwise 'east' if destination is east of origin, 'west' otherwise.
 */
export function classifyDirection(
  originZip: string,
  destZip: string,
  zips: ZipMeta[],
): Direction {
  if (originZip === destZip) return 'neutral';
  if (originZip === 'ALL_OTHER' || destZip === 'ALL_OTHER') return 'neutral';
  const o = zips.find((z) => z.zip === originZip);
  const d = zips.find((z) => z.zip === destZip);
  if (!o || !d || o.lng == null || d.lng == null || o.lat == null || d.lat == null) {
    return 'neutral';
  }
  const dLng = d.lng - o.lng;
  const dLat = d.lat - o.lat;
  // Project longitude to ground distance at the origin's latitude so E-W and
  // N-S deltas are comparable in degrees-as-distance.
  const dx = dLng * Math.cos((o.lat * Math.PI) / 180);
  const dy = dLat;
  // Same-cluster pairs (e.g., adjacent valley ZIPs) — too close to call.
  if (Math.abs(dx) < EW_THRESHOLD_DEG && Math.abs(dy) < EW_THRESHOLD_DEG) {
    return 'neutral';
  }
  // N-S dominated — exclude from east/west binning.
  if (Math.abs(dy) > Math.abs(dx) * NS_DOMINANCE_RATIO) return 'neutral';
  return dLng > 0 ? 'east' : 'west';
}

/**
 * Filter flows by direction. When filter is 'all', returns the input unchanged.
 * Otherwise:
 *   - Self-flows stay visible (within-ZIP commutes are direction-agnostic).
 *   - N-S-dominated and same-cluster pairs (classified 'neutral') are dropped
 *     from east/west buckets — keeping them in would smuggle perpendicular
 *     flows like Rifle→Meeker into the East view.
 *   - ALL_OTHER arcs are dropped per spec — direction is not meaningful for
 *     the off-map residual; its callout in the dashboard is preserved separately.
 */
export function filterByDirection(
  flows: FlowRow[],
  zips: ZipMeta[],
  filter: DirectionFilter,
): FlowRow[] {
  if (filter === 'all') return flows;
  return flows.filter((f) => {
    if (f.originZip === 'ALL_OTHER' || f.destZip === 'ALL_OTHER') return false;
    if (f.originZip === f.destZip) return true;
    return classifyDirection(f.originZip, f.destZip, zips) === filter;
  });
}

/** Return the subset of flows that should be drawn given the current selection. */
export function filterForSelection(
  flows: FlowRow[],
  selectedZip: string | null,
  mode: Mode,
): FlowRow[] {
  if (!selectedZip) return flows;
  return flows.filter((f) =>
    mode === 'inbound' ? f.destZip === selectedZip : f.originZip === selectedZip,
  );
}

// ---------------------------------------------------------------------------
// Segment filter
// ---------------------------------------------------------------------------
// LODES exposes 9 OD segment buckets (3 age × 3 wage × 3 industry NAICS-3)
// per pair. Within a single axis the buckets sum to workerCount within ±2;
// across axes there is no joint cell. The filter UX therefore commits to one
// axis at a time. `applySegmentFilter` rewrites each FlowRow's workerCount to
// the sum of the selected buckets within the active axis so every downstream
// consumer (corridor widths, stats panels, card headlines) re-aggregates
// against the filtered universe with no extra plumbing.

const ALL_BUCKETS_BY_AXIS: Record<'age' | 'wage' | 'naics3', SegmentBucket[]> = {
  age: ['u29', 'age30to54', 'age55plus'],
  wage: ['low', 'mid', 'high'],
  naics3: ['goods', 'tradeTransUtil', 'allOther'],
};

/** True when no segment filter is active OR every bucket within the axis is selected. */
export function isSegmentFilterAll(filter: SegmentFilter): boolean {
  if (filter.axis === 'all') return true;
  const all = ALL_BUCKETS_BY_AXIS[filter.axis];
  if (filter.buckets.length !== all.length) return false;
  return all.every((b) => filter.buckets.includes(b));
}

/** Sum of selected buckets in a FlowRow's segments under the active axis. */
function flowRowSegmentSum(row: FlowRow, filter: SegmentFilter): number {
  const seg = row.segments;
  if (!seg || filter.axis === 'all') return row.workerCount;
  if (filter.buckets.length === 0) return 0;
  if (filter.axis === 'age') {
    let n = 0;
    for (const b of filter.buckets) n += seg.age[b as AgeBucket] ?? 0;
    return n;
  }
  if (filter.axis === 'wage') {
    let n = 0;
    for (const b of filter.buckets) n += seg.wage[b as WageBucket] ?? 0;
    return n;
  }
  // naics3
  let n = 0;
  for (const b of filter.buckets) n += seg.naics3[b as Naics3Bucket] ?? 0;
  return n;
}

/**
 * Return a new FlowRow array whose workerCount has been replaced by the
 * sum of the selected buckets within the active axis. When no filter is
 * active (axis === 'all' OR all buckets in the axis selected), the input
 * array is returned unchanged so consumers can rely on referential equality.
 *
 * Rows missing a `segments` block (legacy JSON) are passed through with
 * their original workerCount — App.tsx warns once in dev when this happens
 * so a stale cached build is detectable.
 */
export function applySegmentFilter(
  flows: FlowRow[],
  filter: SegmentFilter,
): FlowRow[] {
  if (isSegmentFilterAll(filter)) return flows;
  return flows.map((f) => ({ ...f, workerCount: flowRowSegmentSum(f, filter) }));
}

// ---------------------------------------------------------------------------
// Block-level segment filtering helpers — used by BottomCardStrip cards that
// summarize RAC/WAC or OD latest blocks under the segment filter.
// ---------------------------------------------------------------------------

/** Sum the selected buckets out of an AgeBlock / WageBlock / Naics3Block. */
export function sumBucketsFromBlock(
  block: AgeBlock | WageBlock | Naics3Block,
  filter: SegmentFilter,
): number {
  if (filter.axis === 'all' || filter.buckets.length === 0) return 0;
  let n = 0;
  if (filter.axis === 'age') {
    for (const b of filter.buckets) n += (block as AgeBlock)[b as AgeBucket] ?? 0;
  } else if (filter.axis === 'wage') {
    for (const b of filter.buckets) n += (block as WageBlock)[b as WageBucket] ?? 0;
  } else {
    for (const b of filter.buckets) n += (block as Naics3Block)[b as Naics3Bucket] ?? 0;
  }
  return n;
}

/**
 * Filtered headline value for a RAC/WAC or OD latest block:
 *   - filter inactive  → totalJobs (or 0 when block null)
 *   - filter active    → sum of selected buckets within active axis
 * RAC/WAC carry richer dimensions (race, ethnicity, education, sex) — those
 * are not filterable since LODES has no OD analogue. Callers that render
 * those cards keep their full-total behavior independent of the filter.
 */
export function filteredLatestTotal(
  block:
    | { totalJobs: number; age: AgeBlock; wage: WageBlock; naics3: Naics3Block }
    | null,
  filter: SegmentFilter,
): number {
  if (!block) return 0;
  if (isSegmentFilterAll(filter)) return block.totalJobs;
  if (filter.axis === 'age') return sumBucketsFromBlock(block.age, filter);
  if (filter.axis === 'wage') return sumBucketsFromBlock(block.wage, filter);
  return sumBucketsFromBlock(block.naics3, filter);
}

/**
 * Per-year sparkline values for an OdTrend / RacWacTrend under the segment
 * filter. When the filter is inactive, returns trend.totalJobs unchanged.
 * Otherwise: at each year, sums the selected buckets across the trend's
 * per-bucket series. Trends and OD inflow/outflow trends share the same
 * dimension keys (ageU29, age30to54, age55plus, wageLow, …) so this works
 * for any OdTrend / RacWacTrend without further plumbing.
 */
export function filteredTrendSeries(
  trend: OdTrend | null,
  filter: SegmentFilter,
): TrendPoint[] {
  if (!trend) return [];
  if (isSegmentFilterAll(filter)) return trend.totalJobs;
  if (filter.buckets.length === 0) {
    // Filter is active but the user has un-selected every bucket — render a
    // flatlined trend at zero so the sparkline still draws an axis. The
    // BottomCardStrip is responsible for guarding axis !== 'all' && empty.
    return trend.totalJobs.map((p) => ({ year: p.year, value: 0 }));
  }
  const dimsByAxis: Record<
    'age' | 'wage' | 'naics3',
    Record<string, keyof OdTrend>
  > = {
    age: {
      u29: 'ageU29',
      age30to54: 'age30to54',
      age55plus: 'age55plus',
    },
    wage: {
      low: 'wageLow',
      mid: 'wageMid',
      high: 'wageHigh',
    },
    naics3: {
      goods: 'naicsGoods',
      tradeTransUtil: 'naicsTradeTransUtil',
      allOther: 'naicsAllOther',
    },
  };
  const dims = dimsByAxis[filter.axis as 'age' | 'wage' | 'naics3'];
  const series: TrendPoint[][] = filter.buckets.map(
    (b) => trend[dims[b as string]] ?? [],
  );
  // Walk the canonical year set from the totalJobs series so the output is
  // dense across 2002–2023. Each year's value is the sum across selected
  // bucket series at that year (defaults to 0 if a bucket is missing the year).
  return trend.totalJobs.map((p) => {
    let value = 0;
    for (const s of series) {
      const hit = s.find((q) => q.year === p.year);
      if (hit) value += hit.value;
    }
    return { year: p.year, value };
  });
}

/**
 * Filtered OdLatest "totalJobs" only — convenience wrapper used where the
 * caller just needs the headline integer for an OD inflow/outflow/within
 * latest block. Returns 0 when block is null.
 */
export function filteredOdLatestTotal(
  block: OdLatest | null,
  filter: SegmentFilter,
): number {
  return filteredLatestTotal(block, filter);
}
