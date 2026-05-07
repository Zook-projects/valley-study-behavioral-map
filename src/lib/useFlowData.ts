// useFlowData — single source of truth for the LEHD LODES dataset.
// Lifts the two data-loading effects out of CommuteView so both the Map view
// and the new Dashboard view can share fetched data without re-fetching when
// the user switches tabs. Each view still owns its own filter state.

import { useEffect, useMemo, useState } from 'react';
import type {
  CorridorFlowEntry,
  CorridorGraph,
  CorridorId,
  CorridorRecord,
  FlowRow,
  PassThroughFile,
  ZipMeta,
} from '../types/flow';
import type { OdBlocksFile, OdSummaryFile, RacFile, WacFile } from '../types/lodes';
import type { ContextBundle, ContextEnvelope, ContextTopic } from '../types/context';
import {
  buildCorridorFlowIndex,
  indexCorridors,
} from './corridors';
import {
  unionFlowsByPair,
  type DriveDistanceMap,
} from './flowQueries';

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

export interface FlowData {
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  flowsRegional: FlowRow[];
  zips: ZipMeta[];
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  // O(1) lookup of FlowRow by `${originZip}-${destZip}`. Built once from
  // flowsInbound ∪ flowsOutbound (anchor↔anchor pairs dedupe to the inbound
  // copy, which carries the same workerCount and corridorPath). Used by
  // filterFlowsBySelectedBlocks to resolve the canonical corridor path for
  // a synthetic block-aggregated flow row.
  flowsByOdKey: Map<string, FlowRow>;
  racFile: RacFile;
  wacFile: WacFile;
  odSummary: OdSummaryFile;
  driveDistance: DriveDistanceMap | null;
  passThrough: PassThroughFile | null;
  odBlocks: OdBlocksFile | null;
  contextBundle: ContextBundle | null;
}

export interface UseFlowDataResult {
  data: FlowData | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook that fetches the full LEHD LODES + corridor + context bundle once and
 * keeps the result in component state. Returns null `data` until the required
 * (non-optional) files are available; optional files (drive distance,
 * pass-through, OD blocks, context) populate as they resolve.
 */
export function useFlowData(): UseFlowDataResult {
  const [flowsInbound, setFlowsInbound] = useState<FlowRow[] | null>(null);
  const [flowsOutbound, setFlowsOutbound] = useState<FlowRow[] | null>(null);
  const [zips, setZips] = useState<ZipMeta[] | null>(null);
  const [corridorIndex, setCorridorIndex] =
    useState<Map<CorridorId, CorridorRecord> | null>(null);
  const [flowIndex, setFlowIndex] =
    useState<Map<CorridorId, CorridorFlowEntry[]> | null>(null);
  const [racFile, setRacFile] = useState<RacFile | null>(null);
  const [wacFile, setWacFile] = useState<WacFile | null>(null);
  const [odSummary, setOdSummary] = useState<OdSummaryFile | null>(null);
  const [driveDistance, setDriveDistance] = useState<DriveDistanceMap | null>(null);
  const [passThrough, setPassThrough] = useState<PassThroughFile | null>(null);
  const [odBlocks, setOdBlocks] = useState<OdBlocksFile | null>(null);
  const [contextBundle, setContextBundle] = useState<ContextBundle | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Main bundle — flows, ZIP metadata, corridor graph, RAC/WAC/OD plus three
  // optional files. Mirrors the original effect at CommuteView.tsx:371–439.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${DATA_BASE}/flows-inbound.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/flows-outbound.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/zips.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/corridors.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/rac.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/wac.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/od-summary.json`).then((r) => r.json()),
      fetch(`${DATA_BASE}/drive-distance.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`${DATA_BASE}/flows-passthrough.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(`${DATA_BASE}/od-blocks.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([fi, fo, z, cg, rac, wac, od, dd, pt, ob]: [
        FlowRow[],
        FlowRow[],
        ZipMeta[],
        CorridorGraph,
        RacFile,
        WacFile,
        OdSummaryFile,
        DriveDistanceMap | null,
        PassThroughFile | null,
        OdBlocksFile | null,
      ]) => {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          const missing =
            fi.find((f) => !f.segments) ?? fo.find((f) => !f.segments);
          if (missing) {
            console.warn(
              'flow rows are missing per-pair segment breakdowns — segment filter will be inactive. Re-run scripts/build-data.py.',
            );
          }
        }
        setFlowsInbound(fi);
        setFlowsOutbound(fo);
        setZips(z);
        setCorridorIndex(indexCorridors(cg));
        setFlowIndex(buildCorridorFlowIndex(fi, fo));
        setRacFile(rac);
        setWacFile(wac);
        setOdSummary(od);
        setDriveDistance(dd);
        setPassThrough(pt);
        setOdBlocks(ob);
      })
      .catch((err) => {
        console.error('data load failed', err);
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Regional context — six topic JSONs. Mirrors CommuteView.tsx:444–483.
  useEffect(() => {
    let cancelled = false;
    const topics: ContextTopic[] = [
      'demographics',
      'education',
      'employment',
      'housing',
      'commerce',
      'tourism',
    ];
    Promise.all(
      topics.map((t) =>
        fetch(`${DATA_BASE}/context/${t}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ),
    ).then((envelopes) => {
      if (cancelled) return;
      const bundle = {} as ContextBundle;
      topics.forEach((t, i) => {
        const env = envelopes[i] as ContextEnvelope | null;
        bundle[t] =
          env ??
          ({
            topic: t,
            vintageRange: { start: 0, end: 0 },
            sources: [],
            state: null,
            counties: [],
            places: [],
          } as ContextEnvelope);
      });
      setContextBundle(bundle);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Regional flow union — deduped union of inbound + outbound. Powers the
  // synthetic 'regional' mode. Lifted out of CommuteView.tsx:491–494 so both
  // views consume the same precomputed array.
  const flowsRegional = useMemo<FlowRow[] | null>(() => {
    if (!flowsInbound || !flowsOutbound) return null;
    return unionFlowsByPair(flowsInbound, flowsOutbound);
  }, [flowsInbound, flowsOutbound]);

  // OD-keyed flow lookup — `${originZip}-${destZip}` → FlowRow. Anchor↔anchor
  // pairs appear in both inbound and outbound files with identical
  // workerCount and corridorPath; the inbound copy wins on collision so the
  // canonical path is stable.
  const flowsByOdKey = useMemo<Map<string, FlowRow> | null>(() => {
    if (!flowsInbound || !flowsOutbound) return null;
    const out = new Map<string, FlowRow>();
    for (const f of flowsInbound) out.set(`${f.originZip}-${f.destZip}`, f);
    for (const f of flowsOutbound) {
      const key = `${f.originZip}-${f.destZip}`;
      if (out.has(key)) continue;
      out.set(key, f);
    }
    return out;
  }, [flowsInbound, flowsOutbound]);

  const ready =
    !!flowsInbound &&
    !!flowsOutbound &&
    !!flowsRegional &&
    !!flowsByOdKey &&
    !!zips &&
    !!corridorIndex &&
    !!flowIndex &&
    !!racFile &&
    !!wacFile &&
    !!odSummary;

  const data: FlowData | null = ready
    ? {
        flowsInbound: flowsInbound!,
        flowsOutbound: flowsOutbound!,
        flowsRegional: flowsRegional!,
        flowsByOdKey: flowsByOdKey!,
        zips: zips!,
        corridorIndex: corridorIndex!,
        flowIndex: flowIndex!,
        racFile: racFile!,
        wacFile: wacFile!,
        odSummary: odSummary!,
        driveDistance,
        passThrough,
        odBlocks,
        contextBundle,
      }
    : null;

  return { data, isLoading: !ready && !error, error };
}
