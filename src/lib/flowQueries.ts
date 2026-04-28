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
