// FlowDataTables — three tabbed tables that surface the LODES dataset as a
// traditional data view. Each tab is a sortable HTML table styled with the
// project's design tokens. All math goes through existing primitives in
// src/lib/flowQueries.ts and src/lib/corridors.ts — no new query helpers.

import { useMemo, useState } from 'react';
import type {
  CorridorFlowEntry,
  CorridorId,
  CorridorRecord,
  FlowRow,
  Mode,
  ZipMeta,
} from '../../types/flow';
import {
  computeAnchorRankings,
  isAnchorZip,
  type AnchorRanking,
} from '../../lib/flowQueries';
import { buildVisibleCorridorMap } from '../../lib/corridors';
import { fmtInt, fmtPct } from '../../lib/format';

type TabId = 'rankings' | 'pairs' | 'corridors';

interface Props {
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  flowsRegional: FlowRow[];
  // The mode-/direction-/segment-filtered active dataset. Used by the OD
  // pairs and corridor totals tabs so they reflect the current filter state.
  activeFlows: FlowRow[];
  zips: ZipMeta[];
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  mode: Mode;
  selectedZip: string | null;
  onSelectZip: (zip: string | null) => void;
  onSelectPartner: (p: { place: string; zips: string[] } | null) => void;
}

type SortDir = 'asc' | 'desc';

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: SortDir;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider cursor-pointer select-none ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
      style={{
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        borderBottom: '1px solid var(--rule)',
      }}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="hover:underline">
        {label}
        {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Anchor Rankings tab
// ---------------------------------------------------------------------------
function AnchorRankingsTable({
  flowsInbound,
  flowsOutbound,
  zips,
  selectedZip,
  onSelectZip,
}: {
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  zips: ZipMeta[];
  selectedZip: string | null;
  onSelectZip: (zip: string | null) => void;
}) {
  const [sortKey, setSortKey] = useState<string>('inbound');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const rankings = useMemo<AnchorRanking[]>(
    () => computeAnchorRankings(flowsInbound, flowsOutbound, zips),
    [flowsInbound, flowsOutbound, zips],
  );

  const sorted = useMemo(() => {
    const out = rankings.slice();
    out.sort((a, b) => {
      const get = (r: AnchorRanking): number | string => {
        switch (sortKey) {
          case 'zip': return r.zip;
          case 'place': return r.place;
          case 'inbound': return r.inboundCommuters;
          case 'outbound': return r.outboundCommuters;
          case 'within': return r.withinZip;
          case 'localShare': return r.localShare;
          default: return 0;
        }
      };
      const av = get(a);
      const bv = get(b);
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [rankings, sortKey, sortDir]);

  const onSort = (key: string) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'zip' || key === 'place' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] tnum">
        <thead>
          <tr>
            <SortHeader label="ZIP" sortKey="zip" active={sortKey === 'zip'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Place" sortKey="place" active={sortKey === 'place'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Inbound" sortKey="inbound" active={sortKey === 'inbound'} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Outbound" sortKey="outbound" active={sortKey === 'outbound'} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Within" sortKey="within" active={sortKey === 'within'} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Local Share" sortKey="localShare" active={sortKey === 'localShare'} dir={sortDir} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const isSelected = r.zip === selectedZip;
            return (
              <tr
                key={r.zip}
                onClick={() =>
                  onSelectZip(isSelected ? null : r.zip)
                }
                className="cursor-pointer transition-colors hover:bg-white/5"
                style={{
                  background: isSelected ? 'var(--accent-soft)' : undefined,
                }}
                aria-pressed={isSelected}
                role="button"
              >
                <td className="px-2 py-1.5" style={{ color: isSelected ? 'var(--accent)' : 'var(--text-h)' }}>
                  {r.zip}
                </td>
                <td className="px-2 py-1.5" style={{ color: 'var(--text)' }}>{r.place}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text)' }}>{fmtInt(r.inboundCommuters)}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text)' }}>{fmtInt(r.outboundCommuters)}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text)' }}>{fmtInt(r.withinZip)}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-dim)' }}>{fmtPct(r.localShare)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div
        className="px-2 py-1.5 text-[10px]"
        style={{ color: 'var(--text-dim)' }}
      >
        Click a row to scope the dashboard to that anchor. Click again to clear.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top OD Pairs tab
// ---------------------------------------------------------------------------
interface PairRow {
  originZip: string;
  originPlace: string;
  destZip: string;
  destPlace: string;
  workerCount: number;
}

function TopOdPairsTable({
  flows,
  onSelectPartner,
  selectedZip,
}: {
  flows: FlowRow[];
  onSelectPartner: (p: { place: string; zips: string[] } | null) => void;
  selectedZip: string | null;
}) {
  const [sortKey, setSortKey] = useState<string>('workers');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [limit, setLimit] = useState<number>(50);

  const rows = useMemo<PairRow[]>(() => {
    const out: PairRow[] = [];
    for (const f of flows) {
      if (f.originZip === f.destZip) continue;
      out.push({
        originZip: f.originZip,
        originPlace: f.originPlace,
        destZip: f.destZip,
        destPlace: f.destPlace,
        workerCount: f.workerCount,
      });
    }
    return out;
  }, [flows]);

  const total = useMemo(
    () => rows.reduce((s, r) => s + r.workerCount, 0),
    [rows],
  );

  const sorted = useMemo(() => {
    const out = rows.slice();
    out.sort((a, b) => {
      const get = (r: PairRow): number | string => {
        switch (sortKey) {
          case 'originZip': return r.originZip;
          case 'originPlace': return r.originPlace;
          case 'destZip': return r.destZip;
          case 'destPlace': return r.destPlace;
          case 'workers': return r.workerCount;
          default: return 0;
        }
      };
      const av = get(a);
      const bv = get(b);
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out.slice(0, limit);
  }, [rows, sortKey, sortDir, limit]);

  const onSort = (key: string) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'workers' ? 'desc' : 'asc');
    }
  };

  if (rows.length === 0) {
    return (
      <div
        className="text-[11px] italic px-2 py-4"
        style={{ color: 'var(--text-dim)' }}
      >
        No OD pairs match the active filter.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] tnum">
        <thead>
          <tr>
            <SortHeader label="Origin Place" sortKey="originPlace" active={sortKey === 'originPlace'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Origin ZIP" sortKey="originZip" active={sortKey === 'originZip'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Dest Place" sortKey="destPlace" active={sortKey === 'destPlace'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Dest ZIP" sortKey="destZip" active={sortKey === 'destZip'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Workers" sortKey="workers" active={sortKey === 'workers'} dir={sortDir} onSort={onSort} align="right" />
            <th
              className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-right"
              style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--rule)' }}
            >
              % of total
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            // Partner click target: when an anchor is the selected ZIP, the
            // non-anchor side of this pair is the partner. Outside anchor
            // view there's no partner concept, so the row is informational.
            const partnerSide: { place: string; zips: string[] } | null =
              selectedZip && r.destZip === selectedZip
                ? { place: r.originPlace, zips: [r.originZip] }
                : selectedZip && r.originZip === selectedZip
                ? { place: r.destPlace, zips: [r.destZip] }
                : null;
            const handler = partnerSide
              ? () => onSelectPartner(partnerSide)
              : undefined;
            return (
              <tr
                key={`${r.originZip}-${r.destZip}-${i}`}
                onClick={handler}
                className={`transition-colors ${handler ? 'cursor-pointer hover:bg-white/5' : ''}`}
                role={handler ? 'button' : undefined}
              >
                <td className="px-2 py-1.5" style={{ color: 'var(--text-h)' }}>{r.originPlace}</td>
                <td className="px-2 py-1.5" style={{ color: 'var(--text)' }}>{r.originZip}</td>
                <td className="px-2 py-1.5" style={{ color: 'var(--text-h)' }}>{r.destPlace}</td>
                <td className="px-2 py-1.5" style={{ color: 'var(--text)' }}>{r.destZip}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text)' }}>{fmtInt(r.workerCount)}</td>
                <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-dim)' }}>{fmtPct(r.workerCount / Math.max(1, total))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > limit && (
        <div className="flex items-center justify-between px-2 py-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>
          <span>Showing {fmtInt(sorted.length)} of {fmtInt(rows.length)} pairs</span>
          <button
            type="button"
            onClick={() => setLimit((n) => n + 100)}
            className="underline-offset-2 hover:underline"
            style={{ color: 'var(--accent)' }}
          >
            Show 100 more
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Corridor Totals tab
// ---------------------------------------------------------------------------
interface CorridorRow {
  id: CorridorId;
  label: string;
  total: number;
  topOriginPlace: string;
  topOriginCount: number;
  topDestPlace: string;
  topDestCount: number;
}

function CorridorTotalsTable({
  corridorIndex,
  flowIndex,
  flows,
  mode,
  zips,
}: {
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  flows: FlowRow[];
  mode: Mode;
  zips: ZipMeta[];
}) {
  const [sortKey, setSortKey] = useState<string>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const rows = useMemo<CorridorRow[]>(() => {
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, flows, mode);
    const placeOf = (zip: string): string => {
      if (zip === 'GW_E') return 'Eastern I-70';
      if (zip === 'GW_W') return 'Western I-70';
      return zips.find((z) => z.zip === zip)?.place ?? zip;
    };
    const out: CorridorRow[] = [];
    for (const agg of map.values()) {
      let topOriginZip = '';
      let topOriginCount = 0;
      for (const [zip, n] of agg.byOriginZip) {
        if (n > topOriginCount) { topOriginCount = n; topOriginZip = zip; }
      }
      let topDestZip = '';
      let topDestCount = 0;
      for (const [zip, n] of agg.byDestZip) {
        if (n > topDestCount) { topDestCount = n; topDestZip = zip; }
      }
      out.push({
        id: agg.corridor.id,
        label: agg.corridor.label,
        total: agg.total,
        topOriginPlace: topOriginZip ? placeOf(topOriginZip) : '—',
        topOriginCount,
        topDestPlace: topDestZip ? placeOf(topDestZip) : '—',
        topDestCount,
      });
    }
    return out;
  }, [corridorIndex, flowIndex, flows, mode, zips]);

  const sorted = useMemo(() => {
    const out = rows.slice();
    out.sort((a, b) => {
      const get = (r: CorridorRow): number | string => {
        switch (sortKey) {
          case 'label': return r.label;
          case 'total': return r.total;
          case 'topOrigin': return r.topOriginPlace;
          case 'topDest': return r.topDestPlace;
          default: return 0;
        }
      };
      const av = get(a);
      const bv = get(b);
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [rows, sortKey, sortDir]);

  const onSort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'label' ? 'asc' : 'desc'); }
  };

  if (rows.length === 0) {
    return (
      <div
        className="text-[11px] italic px-2 py-4"
        style={{ color: 'var(--text-dim)' }}
      >
        No corridors carry flows under the active filter.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] tnum">
        <thead>
          <tr>
            <SortHeader label="Corridor" sortKey="label" active={sortKey === 'label'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Total Workers" sortKey="total" active={sortKey === 'total'} dir={sortDir} onSort={onSort} align="right" />
            <SortHeader label="Top Origin" sortKey="topOrigin" active={sortKey === 'topOrigin'} dir={sortDir} onSort={onSort} />
            <SortHeader label="Top Destination" sortKey="topDest" active={sortKey === 'topDest'} dir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id}>
              <td className="px-2 py-1.5" style={{ color: 'var(--text-h)' }}>{r.label}</td>
              <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text)' }}>{fmtInt(r.total)}</td>
              <td className="px-2 py-1.5" style={{ color: 'var(--text)' }}>
                {r.topOriginPlace}
                {r.topOriginCount > 0 && (
                  <span style={{ color: 'var(--text-dim)' }}> · {fmtInt(r.topOriginCount)}</span>
                )}
              </td>
              <td className="px-2 py-1.5" style={{ color: 'var(--text)' }}>
                {r.topDestPlace}
                {r.topDestCount > 0 && (
                  <span style={{ color: 'var(--text-dim)' }}> · {fmtInt(r.topDestCount)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level FlowDataTables
// ---------------------------------------------------------------------------
export function FlowDataTables(props: Props) {
  const [tab, setTab] = useState<TabId>('rankings');
  const tabs: { id: TabId; label: string }[] = [
    { id: 'rankings', label: 'Anchor Rankings' },
    { id: 'pairs', label: 'Top OD Pairs' },
    { id: 'corridors', label: 'Corridor Totals' },
  ];

  // Defensive: silence the unused-var warning for the helper imported above.
  void isAnchorZip;

  return (
    <section
      className="rounded-md"
      style={{
        background: 'var(--panel-surface)',
        border: '1px solid var(--panel-border)',
      }}
    >
      <header
        className="flex items-center gap-1 px-2 pt-2"
        style={{ borderBottom: '1px solid var(--rule)' }}
      >
        <span
          className="text-[10px] font-semibold uppercase tracking-wider mr-2 pl-1"
          style={{ color: 'var(--text-dim)' }}
        >
          Flow Data
        </span>
        <div role="tablist" aria-label="Flow data tables" className="flex gap-1">
          {tabs.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className="px-3 py-1.5 text-[11px] font-medium rounded-t transition-colors focus:outline-none focus-visible:ring-1"
                style={{
                  color: active ? 'var(--accent)' : 'var(--text)',
                  background: active ? 'rgba(255,180,84,0.05)' : 'transparent',
                  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: '-1px',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </header>
      <div className="p-2">
        {tab === 'rankings' && (
          <AnchorRankingsTable
            flowsInbound={props.flowsInbound}
            flowsOutbound={props.flowsOutbound}
            zips={props.zips}
            selectedZip={props.selectedZip}
            onSelectZip={props.onSelectZip}
          />
        )}
        {tab === 'pairs' && (
          <TopOdPairsTable
            flows={props.activeFlows}
            onSelectPartner={props.onSelectPartner}
            selectedZip={props.selectedZip}
          />
        )}
        {tab === 'corridors' && (
          <CorridorTotalsTable
            corridorIndex={props.corridorIndex}
            flowIndex={props.flowIndex}
            flows={props.activeFlows}
            mode={props.mode}
            zips={props.zips}
          />
        )}
      </div>
    </section>
  );
}
