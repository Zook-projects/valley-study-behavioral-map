// Shared types for the Placer.ai visitor view emitted by scripts/build-placer.py.
// Wire format for public/data/{placer-visitor-origins,placer-zips,placer-summary}.json.
//
// The visitor view consumes the same corridor graph (corridors.json) as the
// commute view but with a separate flow universe — one row per origin ZIP
// for a single destination (Glenwood Springs, 81601) and a single year (2025).
// Both Placer measures (Visits and Visitors) ride on every flow row so the
// frontend toggle flips between them without re-fetching.

import type { CorridorId } from './flow';

export type VisitorMeasure = 'visits' | 'visitors';

// 'local' = origin within 75 miles of Glenwood Springs (haversine).
// 'non-local' = origin beyond 75 miles. Scope is independent of corridor
// routing — a non-local Denver ZIP can still have a non-empty corridorPath
// through the East gateway; a local UT ZIP without a 80/81 prefix has no
// corridorPath. The Local-only filter on the dashboard hides every
// non-local row regardless of whether it is routable.
export type VisitorScope = 'local' | 'non-local';

// Frontend filter — whether the visitor view shows only local origins
// (within 75 mi of Glenwood) or all origins including the non-local long
// tail (Front Range, out-of-state).
export type VisitorScopeFilter = 'local' | 'all';

// Three preset map extents toggled by the MapScopeControl chip cluster. Each
// preset is a single MapLibre fitBounds call.
export type MapScope = 'valley' | 'state' | 'national';

export interface VisitorMetrics {
  visits: number | null;
  visitors: number | null;
  visitsShare: number | null;
  visitorsShare: number | null;
  visitsYoY: number | null;
  visitorsYoY: number | null;
}

export interface VisitorFlowRow {
  originZip: string;
  originPlace: string;
  originState: string;
  lat: number | null;
  lng: number | null;
  destZip: string;
  destPlace: string;
  year: number;
  source: 'Placer';
  metrics: VisitorMetrics;
  scope: VisitorScope;
  // Haversine distance from Glenwood Springs in miles. Null for origins
  // missing lat/lng (treated as non-local by the build).
  distanceMiles: number | null;
  // Empty for unbindable origins; otherwise an ordered list of corridor IDs
  // from the bound origin node to the destination (GWS). Independent of
  // `scope` — a non-local 80/81xxx ZIP can still be routed through a gateway.
  corridorPath: CorridorId[];
  // Graph node the origin binds to; null when no corridor path exists.
  boundNode: string | null;
}

export interface PlacerZipMeta {
  zip: string;
  place: string;
  state: string;
  lat: number | null;
  lng: number | null;
  scope: VisitorScope;
  boundNode: string | null;
}

export interface VisitorScopeRollup {
  visits: number;
  visitors: number;
  originCount: number;
}

export interface VisitorPlaceSummary {
  place: string;
  state: string;
  scope: VisitorScope;        // promoted to 'local' if any of the place's ZIPs are
  zips: string[];
  visits: number;
  visitors: number;
}

export interface VisitorSummaryFile {
  year: number;
  destZip: string;
  destPlace: string;
  localRadiusMiles: number;
  totals: {
    visits: number;
    visitors: number;
    visitsYoY: number;
    visitorsYoY: number;
  };
  byScope: Record<VisitorScope, VisitorScopeRollup>;
  topPlaces: VisitorPlaceSummary[];
  allPlaces: VisitorPlaceSummary[];
}
