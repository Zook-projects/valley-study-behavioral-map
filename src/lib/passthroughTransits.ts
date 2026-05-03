// Synthetic East ↔ West transit FlowRows derived from the pass-through file.
//
// LODES OD pairs whose endpoints both collapse to the GW_E / GW_W sentinels
// (i.e., commuters whose residence is east of GWS and workplace is west of
// it, or vice versa) never enter flows-inbound.json or flows-outbound.json —
// those build datasets only emit pairs that touch one of the 11 anchor ZIPs.
// The pass-through build, on the other hand, classifies every CO OD row by
// whether its physical commute path traverses each anchor's tree position;
// the GWS pass-through bucket therefore captures the East ↔ West transit
// volume on the I-70 / Hwy 82 spine.
//
// Build a synthetic FlowRow per direction (GW_W → GW_E and GW_E → GW_W) so
// the regional-view corridor renderer in CommuteView can include this volume
// in I-70 corridor totals. The flows are visual-only: callers wire them into
// the `visualFlowIndex` and `visualVisibleFlows` pipeline in aggregate view
// only — left-panel stats and bottom-card aggregations consume the
// un-augmented inbound/outbound datasets and never see these rows.

import type { CorridorId, FlowRow, PassThroughFile } from '../types/flow';

// Corridor traversal from GW_W up I-70 to GWS and through Glenwood Canyon to
// GW_E. Same list works for both directions — corridor-aggregation reads
// corridorPath as an unordered set of touched corridors, not a directed
// route.
const EAST_WEST_CORRIDOR_PATH: CorridorId[] = [
  'GW_W_DBQ',
  'I70_PCT_DBQ',
  'I70_RFL_PCT',
  'I70_SLT_RFL',
  'I70_NCT_SLT',
  'I70_GWS_NCT',
  'GW_E_GWS',
];

// Sentinel ZIP labels emitted by build-passthrough.py for the off-anchor
// gateway buckets. Mirror the corridor graph node IDs exactly.
const GW_E_ZIP = 'GW_E';
const GW_W_ZIP = 'GW_W';

// Anchor whose pass-through bucket exposes the East ↔ West transit volume —
// GWS sits at the I-70 / Hwy 82 junction so its bucket is the one that
// captures any pair whose physical path crosses the valley spine.
const GWS_ANCHOR_ZIP = '81601';

/**
 * Pull GW_W ↔ GW_E pairs from the GWS pass-through bucket and return them as
 * synthetic FlowRows ready to drop into the regional visual pipeline.
 *
 * The pair lists in the pass-through file run through both inbound and
 * outbound buckets after the 2026-05-02 relax of the bucket criteria — same
 * pair appears in both with identical workerCount. We dedupe by
 * `originZip-destZip` and pull each direction at most once. Both buckets
 * agreeing is a sanity check; if they disagree, the inbound figure wins.
 *
 * Returns an empty array when the file isn't loaded yet, when the GWS bucket
 * is missing, or when the file has no GW_E ↔ GW_W transits.
 */
export function buildEastWestTransitFlows(
  passThrough: PassThroughFile | null,
): FlowRow[] {
  if (!passThrough) return [];
  const gws = passThrough.byAnchor[GWS_ANCHOR_ZIP];
  if (!gws) return [];

  const seen = new Map<string, number>();
  const consider = (originZip: string, destZip: string, workerCount: number) => {
    const oIsGw = originZip === GW_E_ZIP || originZip === GW_W_ZIP;
    const dIsGw = destZip === GW_E_ZIP || destZip === GW_W_ZIP;
    if (!oIsGw || !dIsGw || originZip === destZip) return;
    const key = `${originZip}-${destZip}`;
    if (!seen.has(key)) seen.set(key, workerCount);
  };

  for (const p of gws.inbound.pairs) consider(p.originZip, p.destZip, p.workerCount);
  for (const p of gws.outbound.pairs) consider(p.originZip, p.destZip, p.workerCount);

  const placeFor = (zip: string): string =>
    zip === GW_E_ZIP ? 'Eastern I-70' : 'Western I-70';

  const out: FlowRow[] = [];
  for (const [key, workerCount] of seen) {
    const [originZip, destZip] = key.split('-');
    out.push({
      originZip,
      originPlace: placeFor(originZip),
      destZip,
      destPlace: placeFor(destZip),
      workerCount,
      year: passThrough.year,
      source: 'LEHD',
      corridorPath: EAST_WEST_CORRIDOR_PATH,
    });
  }
  return out;
}

/**
 * Apply the dashboard's east/west direction filter to the transit set. The
 * pair's bearing is read directly from the GW_E / GW_W endpoint labels
 * (rather than running classifyDirection over real ZIP coordinates) since
 * the gateway sentinels carry the direction in their ID.
 *
 *   GW_W → GW_E  → eastbound traffic (kept on filter === 'east')
 *   GW_E → GW_W  → westbound traffic (kept on filter === 'west')
 *
 * Returns the input array unchanged when the filter is 'all'.
 */
export function filterEastWestTransits(
  transits: FlowRow[],
  directionFilter: 'all' | 'east' | 'west',
): FlowRow[] {
  if (directionFilter === 'all') return transits;
  return transits.filter((f) => {
    if (f.originZip === GW_W_ZIP && f.destZip === GW_E_ZIP) return directionFilter === 'east';
    if (f.originZip === GW_E_ZIP && f.destZip === GW_W_ZIP) return directionFilter === 'west';
    return false;
  });
}
