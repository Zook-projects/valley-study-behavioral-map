// FlowCharts — four small D3 charts that render the same dataset surfaced in
// the tables, in visual form. SVG-based, scaled to container width via
// preserveAspectRatio="none". Mirrors the d3-shape pattern used by
// BottomCardStrip's sparklines so styling and feel stay consistent.

import { useMemo } from 'react';
import {
  arc as d3Arc,
  pie as d3Pie,
  type PieArcDatum,
} from 'd3-shape';
import type {
  CorridorFlowEntry,
  CorridorId,
  CorridorRecord,
  FlowRow,
  Mode,
  SegmentAxis,
  SegmentBucket,
  SegmentFilter,
  ZipMeta,
} from '../../types/flow';
import { buildVisibleCorridorMap } from '../../lib/corridors';
import { classifyDirection } from '../../lib/flowQueries';
import { fmtInt, fmtPct } from '../../lib/format';

// Common neutral palette pulled from --corridor-1..5 so charts harmonise with
// the corridor ramp used on the map. The accent (warm amber) marks "primary"
// values inside each chart.
const C_DIM = 'var(--corridor-2)';
const C_MID = 'var(--corridor-3)';
const C_HIGH = 'var(--corridor-4)';
const C_TOP = 'var(--corridor-5)';

function ChartFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2 min-h-[180px]"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--panel-border)',
      }}
    >
      <div>
        <div
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-h)' }}
        >
          {title}
        </div>
        {subtitle && (
          <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {subtitle}
          </div>
        )}
      </div>
      <div className="flex-1 flex items-center">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Direction Split — horizontal bar (East / West / Neutral)
// ---------------------------------------------------------------------------
function DirectionSplit({ flows, zips }: { flows: FlowRow[]; zips: ZipMeta[] }) {
  const buckets = useMemo(() => {
    let east = 0, west = 0, neutral = 0;
    for (const f of flows) {
      if (f.originZip === f.destZip) {
        neutral += f.workerCount;
        continue;
      }
      if (f.originZip === 'ALL_OTHER' || f.destZip === 'ALL_OTHER') {
        neutral += f.workerCount;
        continue;
      }
      const dir = classifyDirection(f.originZip, f.destZip, zips);
      if (dir === 'east') east += f.workerCount;
      else if (dir === 'west') west += f.workerCount;
      else neutral += f.workerCount;
    }
    return [
      { label: 'Eastbound', value: east, color: C_TOP },
      { label: 'Westbound', value: west, color: C_HIGH },
      { label: 'Neutral / Self', value: neutral, color: C_DIM },
    ];
  }, [flows, zips]);

  const total = buckets.reduce((s, b) => s + b.value, 0) || 1;

  return (
    <div className="w-full flex flex-col gap-2">
      {buckets.map((b) => (
        <div key={b.label} className="flex items-center gap-2">
          <div
            className="w-20 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            {b.label}
          </div>
          <div className="flex-1 relative h-3 rounded" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <div
              className="absolute inset-y-0 left-0 rounded transition-all"
              style={{
                width: `${(b.value / total) * 100}%`,
                background: b.color,
              }}
            />
          </div>
          <div className="w-20 text-right text-[11px] tnum" style={{ color: 'var(--text-h)' }}>
            {fmtInt(b.value)}
          </div>
          <div className="w-12 text-right text-[10px] tnum" style={{ color: 'var(--text-dim)' }}>
            {fmtPct(b.value / total)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode Split — donut (Inbound / Outbound / Within)
// ---------------------------------------------------------------------------
function ModeSplit({
  flowsInbound,
  flowsOutbound,
}: {
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
}) {
  const buckets = useMemo(() => {
    // Within = self-flows (origin === dest); inbound/outbound = the rest of
    // each dataset, excluding the within bucket from inbound to avoid
    // double-counting since self-flows appear there only.
    let within = 0, inbound = 0, outbound = 0;
    for (const f of flowsInbound) {
      if (f.originZip === f.destZip) within += f.workerCount;
      else inbound += f.workerCount;
    }
    for (const f of flowsOutbound) {
      if (f.originZip === f.destZip) continue; // already in `within`
      outbound += f.workerCount;
    }
    return [
      { label: 'Inbound', value: inbound, color: 'var(--accent)' },
      { label: 'Outbound', value: outbound, color: C_HIGH },
      { label: 'Within ZIP', value: within, color: C_DIM },
    ];
  }, [flowsInbound, flowsOutbound]);
  const total = buckets.reduce((s, b) => s + b.value, 0) || 1;

  // d3-shape pie + arc generators. SVG viewBox is square; arcs sit at the
  // visual center.
  const pie = d3Pie<typeof buckets[number]>().sort(null).value((d) => d.value);
  const arcs = pie(buckets);
  const arc = d3Arc<PieArcDatum<typeof buckets[number]>>()
    .innerRadius(38)
    .outerRadius(58);

  return (
    <div className="w-full flex items-center gap-3">
      <svg viewBox="0 0 140 140" className="w-[120px] h-[120px] shrink-0" aria-hidden="true">
        <g transform="translate(70,70)">
          {arcs.map((a, i) => (
            <path
              key={i}
              d={arc(a) ?? undefined}
              fill={buckets[i].color}
              stroke="var(--bg-base)"
              strokeWidth={1}
            />
          ))}
        </g>
      </svg>
      <div className="flex-1 flex flex-col gap-1.5 text-[11px]">
        {buckets.map((b) => (
          <div key={b.label} className="flex items-center justify-between gap-2 tnum">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: b.color }} />
              <span style={{ color: 'var(--text)' }}>{b.label}</span>
            </span>
            <span style={{ color: 'var(--text-h)' }}>
              {fmtInt(b.value)}{' '}
              <span style={{ color: 'var(--text-dim)' }}>· {fmtPct(b.value / total)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segment Breakdown — grouped bar over the active or default segment axis
// ---------------------------------------------------------------------------
const AGE_LABELS: Record<string, string> = {
  u29: 'Under 30',
  age30to54: '30–54',
  age55plus: '55+',
};
const WAGE_LABELS: Record<string, string> = {
  low: '≤ $1,250/mo',
  mid: '$1,251–$3,333',
  high: '> $3,333/mo',
};
const NAICS_LABELS: Record<string, string> = {
  goods: 'Goods',
  tradeTransUtil: 'Trade · Trans · Util',
  allOther: 'All Other',
};

function SegmentBreakdown({
  flows,
  segmentFilter,
}: {
  flows: FlowRow[];
  segmentFilter: SegmentFilter;
}) {
  // When the filter is 'all', default the chart to age axis so it always has
  // something to show. Otherwise honour the user's chosen axis.
  const axis: Exclude<SegmentAxis, 'all'> =
    segmentFilter.axis === 'all' ? 'age' : segmentFilter.axis;

  const data = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const f of flows) {
      const seg = f.segments;
      if (!seg) continue;
      if (axis === 'age') {
        acc.u29 = (acc.u29 ?? 0) + seg.age.u29;
        acc.age30to54 = (acc.age30to54 ?? 0) + seg.age.age30to54;
        acc.age55plus = (acc.age55plus ?? 0) + seg.age.age55plus;
      } else if (axis === 'wage') {
        acc.low = (acc.low ?? 0) + seg.wage.low;
        acc.mid = (acc.mid ?? 0) + seg.wage.mid;
        acc.high = (acc.high ?? 0) + seg.wage.high;
      } else {
        acc.goods = (acc.goods ?? 0) + seg.naics3.goods;
        acc.tradeTransUtil = (acc.tradeTransUtil ?? 0) + seg.naics3.tradeTransUtil;
        acc.allOther = (acc.allOther ?? 0) + seg.naics3.allOther;
      }
    }
    const labels = axis === 'age' ? AGE_LABELS : axis === 'wage' ? WAGE_LABELS : NAICS_LABELS;
    return Object.keys(labels).map((k) => ({
      key: k as SegmentBucket,
      label: labels[k],
      value: acc[k] ?? 0,
    }));
  }, [flows, axis]);

  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const axisLabel =
    axis === 'age' ? 'Age' : axis === 'wage' ? 'Earnings' : 'Industry (NAICS-3)';

  return (
    <div className="w-full flex flex-col gap-2">
      <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
        Axis: <span style={{ color: 'var(--text-h)' }}>{axisLabel}</span>
        {segmentFilter.axis === 'all' && ' (default — flip the segment filter to switch axes)'}
      </div>
      {data.map((d, i) => {
        const active = segmentFilter.buckets.includes(d.key);
        return (
          <div key={d.key} className="flex items-center gap-2">
            <div
              className="w-32 text-[10px] uppercase tracking-wider truncate"
              style={{ color: 'var(--text-dim)' }}
              title={d.label}
            >
              {d.label}
            </div>
            <div
              className="flex-1 relative h-3 rounded"
              style={{ background: 'rgba(255,255,255,0.05)' }}
            >
              <div
                className="absolute inset-y-0 left-0 rounded transition-all"
                style={{
                  width: `${(d.value / max) * 100}%`,
                  background: active
                    ? 'var(--accent)'
                    : i === 0
                    ? C_TOP
                    : i === 1
                    ? C_HIGH
                    : C_MID,
                }}
              />
            </div>
            <div className="w-20 text-right text-[11px] tnum" style={{ color: 'var(--text-h)' }}>
              {fmtInt(d.value)}
            </div>
            <div className="w-12 text-right text-[10px] tnum" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(d.value / total)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top Corridors — horizontal bar of the top N by total workers
// ---------------------------------------------------------------------------
function TopCorridors({
  corridorIndex,
  flowIndex,
  flows,
  mode,
  topN = 10,
}: {
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  flows: FlowRow[];
  mode: Mode;
  topN?: number;
}) {
  const rows = useMemo(() => {
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, flows, mode);
    const out = Array.from(map.values()).map((agg) => ({
      label: agg.corridor.label,
      value: agg.total,
    }));
    out.sort((a, b) => b.value - a.value);
    return out.slice(0, topN);
  }, [corridorIndex, flowIndex, flows, mode, topN]);

  const max = Math.max(1, ...rows.map((r) => r.value));

  if (rows.length === 0) {
    return (
      <div className="text-[11px] italic" style={{ color: 'var(--text-dim)' }}>
        No corridor activity under the active filter.
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <div key={r.label} className="flex items-center gap-2">
          <div
            className="w-44 text-[10px] truncate"
            style={{ color: 'var(--text)' }}
            title={r.label}
          >
            {r.label}
          </div>
          <div
            className="flex-1 relative h-2.5 rounded"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded"
              style={{
                width: `${(r.value / max) * 100}%`,
                background: i === 0 ? 'var(--accent)' : i < 3 ? C_TOP : C_HIGH,
              }}
            />
          </div>
          <div
            className="w-20 text-right text-[11px] tnum"
            style={{ color: 'var(--text-h)' }}
          >
            {fmtInt(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level FlowCharts container — 2×2 grid on desktop, single column on mobile
// ---------------------------------------------------------------------------
interface Props {
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  // The mode-/direction-/segment-filtered active dataset.
  activeFlows: FlowRow[];
  zips: ZipMeta[];
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  mode: Mode;
  segmentFilter: SegmentFilter;
}

export function FlowCharts({
  flowsInbound,
  flowsOutbound,
  activeFlows,
  zips,
  corridorIndex,
  flowIndex,
  mode,
  segmentFilter,
}: Props) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <ChartFrame
        title="Direction split"
        subtitle="Workers by geographic bearing of the OD pair"
      >
        <DirectionSplit flows={activeFlows} zips={zips} />
      </ChartFrame>
      <ChartFrame
        title="Mode split"
        subtitle="Inbound · Outbound · Within ZIP"
      >
        <ModeSplit flowsInbound={flowsInbound} flowsOutbound={flowsOutbound} />
      </ChartFrame>
      <ChartFrame
        title="Segment breakdown"
        subtitle="Distribution of workers along the active segment axis"
      >
        <SegmentBreakdown flows={activeFlows} segmentFilter={segmentFilter} />
      </ChartFrame>
      <ChartFrame
        title="Top corridors"
        subtitle="Highest-volume road segments by worker count"
      >
        <TopCorridors
          corridorIndex={corridorIndex}
          flowIndex={flowIndex}
          flows={activeFlows}
          mode={mode}
        />
      </ChartFrame>
    </section>
  );
}
