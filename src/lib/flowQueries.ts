// Pure functions for inbound/outbound lookups across the FlowRow set.

import type { Direction, DirectionFilter, FlowRow, Mode, ZipMeta } from '../types/flow';

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
