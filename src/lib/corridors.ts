// corridors.ts — Mode-aware aggregation over the corridor graph.
//
// Mode-exclusivity invariant
// --------------------------
// At any moment the map renders exactly one mode (inbound XOR outbound). All
// runtime consumers must filter to the active mode's visible flow set before
// reading totals or per-zip breakdowns. Build-time produces no precomputed
// mode-specific totals — that would lock in a filter snapshot the runtime
// can't reuse.
//
// Consumers and where the invariant is enforced:
//   - App.tsx                  selects `flows = mode === 'inbound' ? flowsInbound : flowsOutbound`
//   - DashboardTile.tsx        passes only the active `flows` to stats panels
//   - StatsAggregated.tsx      reads only the prop it receives (active mode)
//   - StatsForZip.tsx          reads only the prop it receives (active mode)
//   - MapCanvas.tsx            builds visibleCorridorMap from the active mode only
//   - aggregateCorridor()      takes `mode` and picks byDestZip vs byOriginZip
//
// No code path should produce a tooltip, stat, or rendered corridor that mixes
// inbound and outbound flows.

import type {
  ActiveCorridorAggregation,
  CorridorFlowEntry,
  CorridorGraph,
  CorridorId,
  CorridorRecord,
  FlowRow,
  Mode,
} from '../types/flow';

/** Stable flow-id derived from origin/dest. Mirrors build-data.py. */
export const flowIdOf = (f: FlowRow): string => `${f.originZip}-${f.destZip}`;

/**
 * Index the corridor graph by ID for O(1) lookup. Done once at mount; the
 * resulting Map is held in App state and passed to MapCanvas.
 */
export function indexCorridors(
  graph: CorridorGraph,
): Map<CorridorId, CorridorRecord> {
  if (graph.version !== 1) {
    throw new Error(`unsupported corridors.json version: ${graph.version}`);
  }
  const out = new Map<CorridorId, CorridorRecord>();
  for (const c of graph.corridors) out.set(c.id, c);
  return out;
}

/**
 * Build an inverted index from corridor ID → list of flow entries that
 * traverse it. The entry list spans both modes; aggregateCorridor() filters
 * to the active mode at hover time.
 *
 * Done once per (flowsInbound + flowsOutbound) load. Re-runs are cheap —
 * O(total flows × avg path length).
 */
export function buildCorridorFlowIndex(
  flowsInbound: FlowRow[],
  flowsOutbound: FlowRow[],
): Map<CorridorId, CorridorFlowEntry[]> {
  const out = new Map<CorridorId, CorridorFlowEntry[]>();

  const append = (f: FlowRow, direction: Mode) => {
    const path = f.corridorPath;
    if (!path || path.length === 0) return;
    const entry: CorridorFlowEntry = {
      flowId: flowIdOf(f),
      originZip: f.originZip,
      destZip: f.destZip,
      workerCount: f.workerCount,
      direction,
    };
    for (const cid of path) {
      let bucket = out.get(cid);
      if (!bucket) {
        bucket = [];
        out.set(cid, bucket);
      }
      bucket.push(entry);
    }
  };

  for (const f of flowsInbound) append(f, 'inbound');
  for (const f of flowsOutbound) append(f, 'outbound');

  // Stable ordering: direction asc, then flowId asc.
  for (const list of out.values()) {
    list.sort((x, y) =>
      x.direction === y.direction
        ? x.flowId.localeCompare(y.flowId)
        : x.direction.localeCompare(y.direction),
    );
  }
  return out;
}

/**
 * Filter a single corridor's flow entries to the active mode's visible flow
 * set and roll up by destination ZIP (outbound) or origin ZIP (inbound).
 */
export function aggregateCorridor(
  corridor: CorridorRecord,
  entries: CorridorFlowEntry[],
  visibleFlowIds: Set<string>,
  mode: Mode,
): ActiveCorridorAggregation {
  let total = 0;
  const byDestZip = new Map<string, number>();
  const byOriginZip = new Map<string, number>();
  const flows: CorridorFlowEntry[] = [];

  for (const fr of entries) {
    if (fr.direction !== mode) continue;
    if (!visibleFlowIds.has(fr.flowId)) continue;
    total += fr.workerCount;
    byDestZip.set(fr.destZip, (byDestZip.get(fr.destZip) ?? 0) + fr.workerCount);
    byOriginZip.set(
      fr.originZip,
      (byOriginZip.get(fr.originZip) ?? 0) + fr.workerCount,
    );
    flows.push(fr);
  }

  return {
    corridorId: corridor.id,
    corridor,
    total,
    byDestZip,
    byOriginZip,
    flows,
  };
}

/**
 * Build the mode-aware visible-corridor map from the active flow set.
 * Corridors with no surviving flows are dropped so the renderer iterates only
 * what it will paint.
 */
export function buildVisibleCorridorMap(
  corridorIndex: Map<CorridorId, CorridorRecord>,
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>,
  visibleFlows: FlowRow[],
  mode: Mode,
): Map<CorridorId, ActiveCorridorAggregation> {
  const visibleFlowIds = new Set(visibleFlows.map(flowIdOf));
  const out = new Map<CorridorId, ActiveCorridorAggregation>();

  for (const [cid, corridor] of corridorIndex) {
    const entries = flowIndex.get(cid);
    if (!entries) continue;
    if (!entries.some((fr) => fr.direction === mode)) continue;
    const agg = aggregateCorridor(corridor, entries, visibleFlowIds, mode);
    if (agg.total === 0 || agg.flows.length === 0) continue;
    out.set(cid, agg);
  }

  return out;
}
