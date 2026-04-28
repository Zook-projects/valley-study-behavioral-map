// Shared types for flow + ZIP + corridor records emitted by scripts/build-data.py.

export type Mode = 'inbound' | 'outbound';

// Geographic bearing of an O-D pair, derived from longitude difference.
// Self-flows, ALL_OTHER endpoints, and near-aligned pairs (|Δlng| < 0.05°)
// classify as 'neutral'. See classifyDirection().
export type Direction = 'east' | 'west' | 'neutral';

// 3-state direction filter for the dashboard. 'all' = unfiltered.
export type DirectionFilter = 'all' | 'east' | 'west';

export interface FlowRow {
  // Inbound dataset: originZip is residence (or 'ALL_OTHER' residual), destZip is anchor workplace.
  // Outbound dataset: originZip is anchor residence, destZip is workplace (or 'ALL_OTHER' residual).
  originZip: string;
  originPlace: string;
  destZip: string;
  destPlace: string;
  workerCount: number;
  percentage: number;         // share-of-anchor, sums to ~1.0 per anchor ZIP
  year: number;
  source: 'LEHD';             // future-proofed for Placer/ACS/RFTA
  // Ordered list of corridor IDs the flow traverses. Empty for self-flows
  // (origin == dest) and any flow whose endpoints reclassified to ALL_OTHER.
  corridorPath: CorridorId[];
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
export interface CorridorFlowEntry {
  flowId: string;             // `${originZip}-${destZip}`
  originZip: string;
  destZip: string;
  workerCount: number;
  direction: Mode;
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
