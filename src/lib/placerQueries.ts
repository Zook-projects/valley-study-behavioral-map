// placerQueries.ts — Pure selectors over the Placer visitor rows + an
// adapter that projects them into FlowRow shape so the existing corridor
// aggregation pipeline (lib/corridors.ts) can consume them unchanged.
//
// The adapter is the load-bearing piece: visitor rows carry a `metrics`
// block with both Visits and Visitors counts, but the corridor pipeline
// expects a single `workerCount` per row. We project to whichever measure
// the user has selected at view time, so corridor stroke widths re-bucket
// when the measure toggle flips.

import type { FlowRow } from '../types/flow';
import type {
  VisitorFlowRow,
  VisitorMeasure,
  VisitorScopeFilter,
} from '../types/placer';

/**
 * Project a visitor flow row into the FlowRow shape consumed by corridor
 * aggregation. The chosen measure becomes `workerCount`; everything else
 * collapses to constants. Rows whose chosen measure is null are dropped
 * upstream (filterVisibleVisitorFlows).
 */
export function projectVisitorRow(
  v: VisitorFlowRow,
  measure: VisitorMeasure,
): FlowRow {
  const count = measure === 'visits' ? v.metrics.visits : v.metrics.visitors;
  return {
    originZip: v.originZip,
    originPlace: v.originPlace,
    destZip: v.destZip,
    destPlace: v.destPlace,
    workerCount: count ?? 0,
    year: v.year,
    // Fudge: corridors.ts and MapCanvas only read `source` indirectly via
    // the FlowRow type; setting it to 'LEHD' avoids type errors but does not
    // affect rendering. The visitor view never feeds these rows back into
    // any LODES-specific code path.
    source: 'LEHD',
    corridorPath: v.corridorPath,
  };
}

/**
 * Apply scope + measure filters and return a FlowRow-shaped array ready for
 * buildVisibleCorridorMap. Rows without the chosen measure (e.g., a ZIP that
 * appears in the Visits table but not Visitors) are dropped — including a
 * zero-count row would distort corridor totals.
 */
export function filterVisibleVisitorFlows(
  rows: VisitorFlowRow[],
  measure: VisitorMeasure,
  scopeFilter: VisitorScopeFilter,
): FlowRow[] {
  const out: FlowRow[] = [];
  for (const r of rows) {
    if (scopeFilter === 'local' && r.scope !== 'local') continue;
    const c = measure === 'visits' ? r.metrics.visits : r.metrics.visitors;
    if (c == null || c === 0) continue;
    out.push(projectVisitorRow(r, measure));
  }
  return out;
}

/**
 * Headline totals for the active filter state. Returns a `{ visits, visitors }`
 * pair so the bottom card strip can show both regardless of which measure
 * drives the map.
 */
export function totalsForScope(
  rows: VisitorFlowRow[],
  scopeFilter: VisitorScopeFilter,
): { visits: number; visitors: number; originCount: number } {
  let visits = 0;
  let visitors = 0;
  let originCount = 0;
  for (const r of rows) {
    if (scopeFilter === 'local' && r.scope !== 'local') continue;
    if (r.metrics.visits) visits += r.metrics.visits;
    if (r.metrics.visitors) visitors += r.metrics.visitors;
    originCount += 1;
  }
  return { visits, visitors, originCount };
}

/**
 * Top-N origin places under the current filter. Multi-ZIP places (Grand
 * Junction, Eagle) collapse to one entry. Returned sorted desc by the
 * active measure.
 */
export interface TopPlaceEntry {
  place: string;
  state: string;
  zips: string[];
  scope: 'local' | 'non-local';
  visits: number;
  visitors: number;
}

export function topOriginPlaces(
  rows: VisitorFlowRow[],
  measure: VisitorMeasure,
  scopeFilter: VisitorScopeFilter,
  limit = 10,
): TopPlaceEntry[] {
  const byKey = new Map<string, TopPlaceEntry>();
  for (const r of rows) {
    if (scopeFilter === 'local' && r.scope !== 'local') continue;
    if (r.originZip === r.destZip) continue;
    const place = r.originPlace || r.originZip;
    const key = `${place}|${r.originState}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        place,
        state: r.originState,
        zips: [],
        scope: r.scope,
        visits: 0,
        visitors: 0,
      };
      byKey.set(key, entry);
    }
    if (!entry.zips.includes(r.originZip)) entry.zips.push(r.originZip);
    // Promote place scope to 'local' if any contributing ZIP is local.
    if (r.scope === 'local') entry.scope = 'local';
    if (r.metrics.visits) entry.visits += r.metrics.visits;
    if (r.metrics.visitors) entry.visitors += r.metrics.visitors;
  }
  for (const e of byKey.values()) e.zips.sort();
  const all = Array.from(byKey.values()).sort((a, b) => {
    const av = measure === 'visits' ? a.visits : a.visitors;
    const bv = measure === 'visits' ? b.visits : b.visitors;
    if (bv !== av) return bv - av;
    return a.place.localeCompare(b.place);
  });
  return all.slice(0, limit);
}

/**
 * Map scope → bounds tuple consumed by MapLibre's fitBounds. Kept here so the
 * three presets live in one place and the visitor view can fit-bounds without
 * importing maplibre types into UI components that don't otherwise need them.
 */
export const MAP_SCOPE_BOUNDS: Record<
  'valley' | 'state' | 'national',
  [[number, number], [number, number]]
> = {
  // Existing valley extent — matches MapCanvas.tsx initial bounds so the
  // first paint of the visitor view matches the commute view's framing.
  valley: [
    [-108.45, 39.05],
    [-106.65, 39.85],
  ],
  // Colorado + sliver of UT/WY for in-state context.
  state: [
    [-109.1, 36.9],
    [-102.0, 41.1],
  ],
  // CONUS — coastal padding kept tight so origin dots in CA/NY don't get
  // pushed into the corner.
  national: [
    [-125, 24],
    [-66, 50],
  ],
};
