// Shared types for flow + ZIP + corridor records emitted by scripts/build-data.py.

import type { AgeBlock, Naics3Block, WageBlock } from './lodes';

// 'inbound' / 'outbound' identify which build-time dataset a flow came from
// (workplace-anchored vs residence-anchored). 'regional' is a runtime-only
// synthetic mode used when no ZIP is selected — the visible flow set is the
// deduped union of inbound + outbound, and corridor aggregation accepts any
// direction. Build artifacts never carry direction === 'regional'; only the
// runtime-constructed FlowRow array (flowsRegional in App.tsx) does.
export type Mode = 'inbound' | 'outbound' | 'regional';

// Geographic bearing of an O-D pair, derived from longitude difference.
// Self-flows, ALL_OTHER endpoints, and near-aligned pairs (|Δlng| < 0.05°)
// classify as 'neutral'. See classifyDirection().
export type Direction = 'east' | 'west' | 'neutral';

// Direction filter for the dashboard. 'all' = unfiltered.
// 'up-valley' filters like 'east' but restricts flows to anchor-ZIP workplaces.
// 'down-valley' is an alias for 'west' (valley-terminology label).
export type DirectionFilter = 'all' | 'east' | 'west' | 'up-valley' | 'down-valley';

// Per-pair worker breakdowns LODES publishes on every OD row. Within an axis
// the buckets sum to workerCount within ±2 (LODES noise infusion). LODES does
// not publish cross-axis joint cells, so the filter UI commits to one axis at
// a time — see SegmentFilter below.
export interface FlowSegments {
  age: AgeBlock;
  wage: WageBlock;
  naics3: Naics3Block;
}

// Active segment-filter axis. 'all' = no filter.
export type SegmentAxis = 'all' | 'age' | 'wage' | 'naics3';

// Bucket keys for each axis. Kept as a single union so the filter state can
// hold any combination within whichever axis is active.
export type AgeBucket = 'u29' | 'age30to54' | 'age55plus';
export type WageBucket = 'low' | 'mid' | 'high';
export type Naics3Bucket = 'goods' | 'tradeTransUtil' | 'allOther';
export type SegmentBucket = AgeBucket | WageBucket | Naics3Bucket;

export interface SegmentFilter {
  axis: SegmentAxis;
  // Buckets within the active axis. Empty when axis === 'all'. When all three
  // buckets within an axis are selected, the filter folds back to axis: 'all'.
  buckets: SegmentBucket[];
}

export interface FlowRow {
  // Inbound dataset: originZip is residence (or 'ALL_OTHER' residual), destZip is anchor workplace.
  // Outbound dataset: originZip is anchor residence, destZip is workplace (or 'ALL_OTHER' residual).
  originZip: string;
  originPlace: string;
  destZip: string;
  destPlace: string;
  workerCount: number;
  year: number;
  source: 'LEHD';             // future-proofed for ACS/RFTA
  // Ordered list of corridor IDs the flow traverses. Empty for self-flows
  // (origin == dest) and any flow whose endpoints reclassified to ALL_OTHER.
  corridorPath: CorridorId[];
  // Per-pair LODES OD segment breakdowns. Optional so legacy callers and
  // older cached JSON still type-check; build-data.py emits this on every
  // row from the 2026-04-29 build forward.
  segments?: FlowSegments;
}

export interface ZipMeta {
  zip: string;
  place: string;
  lat: number | null;
  lng: number | null;
  totalAsWorkplace: number;
  totalAsResidence: number;
  isAnchor: boolean;
  isSynthetic?: boolean;      // true only for the ALL_OTHER off-map node
}

// ---------------------------------------------------------------------------
// Corridor graph types — populated at build time, immutable at runtime.
// ---------------------------------------------------------------------------

export type CorridorId = string;
export type NodeId = string;

export interface CorridorNode {
  id: NodeId;
  label: string;
  lng: number;
  lat: number;
  zip: string | null;         // associated ZIP, if any (e.g., GWS → 81601)
}

export interface CorridorRecord {
  id: CorridorId;
  label: string;              // long-form, e.g., "Hwy 82 — Carbondale to Glenwood"
  from: NodeId;
  to: NodeId;
  roadName: string;           // e.g., "Hwy 82" — surfaces in tooltip subhead/footer
  geometry: [number, number][]; // smoothed polyline (lng, lat)
  lengthMeters: number;
}

// Wire format for public/data/corridors.json.
export interface CorridorGraph {
  version: 1;
  nodes: CorridorNode[];
  corridors: CorridorRecord[];
}

// Flow entry attached to a corridor at runtime — the record that powers the
// hover tooltip aggregation. Built from FlowRow + corridorPath traversals.
// The `direction` tag identifies which build dataset (inbound vs outbound)
// the entry was sourced from — never 'regional', which is a runtime-only
// synthetic mode that aggregateCorridor handles via flowId deduplication.
export interface CorridorFlowEntry {
  flowId: string;             // `${originZip}-${destZip}`
  originZip: string;
  destZip: string;
  workerCount: number;
  direction: 'inbound' | 'outbound';
}

// Pass-through OD pairs around an anchor — flows where neither residence
// nor workplace is the selected anchor and the residence sits on one
// geographic side (E/W) of the anchor while the workplace sits on the
// other. Built by scripts/build-passthrough.py from the latest LODES year.
// The wire format drops segment breakdowns and corridor paths to keep the
// file small.
//
// Mode-aware buckets:
//   inbound  — workplace ∈ {other 10 anchors} (selected anchor's mode is
//              "commute IN", so we focus on flows passing through to a
//              different anchor workplace)
//   outbound — residence ∈ {other 10 anchors} (selected anchor's mode is
//              "commute OUT", so we focus on flows where another anchor's
//              residents pass through this anchor on their commute)
// Pairs where both endpoints are anchors appear in both buckets.
export interface PassThroughPair {
  originZip: string;
  destZip: string;
  workerCount: number;
}

export interface PassThroughModeEntry {
  // Top-N pairs sorted desc by workerCount (cap defined by build script).
  pairs: PassThroughPair[];
  // Sum of workerCounts for pairs beyond the cap. Surfaced as "All other"
  // residual on both sides of the cross-filter card.
  residual: number;
}

export interface PassThroughAnchorEntry {
  // Canonical pass-through volume across BOTH directions for the anchor —
  // sum of every worker whose commute path on the I-70 / Hwy 82 tree
  // topology passes strictly through this anchor (excluding endpoints).
  // Includes non-anchor endpoints after sentinel collapse. Surfaced as the
  // headline "Total pass-through volume" on the card; resolves the
  // inbound/outbound asymmetry that the old longitude-XOR check produced.
  // Spur anchors (OSM, SMV) are 0 by construction — terminal off-corridor
  // ZIPs have no through-traffic.
  total: number;
  inbound: PassThroughModeEntry;
  outbound: PassThroughModeEntry;
}

export interface PassThroughFile {
  year: number;
  pairsPerAnchorPerMode: number;
  byAnchor: Record<string, PassThroughAnchorEntry>;
}

// Mode-aware runtime rollup keyed by corridor.
export interface ActiveCorridorAggregation {
  corridorId: CorridorId;
  corridor: CorridorRecord;
  total: number;                              // sum of workers across visible flows
  byDestZip: Map<string, number>;             // outbound: dest → workers
  byOriginZip: Map<string, number>;           // inbound: origin → workers
  flows: CorridorFlowEntry[];                 // raw entries used for the rollup
}
