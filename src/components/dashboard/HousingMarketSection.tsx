// HousingMarketSection — full Zillow ZHVI panel for the Dashboard's Housing
// section. Renders five charts driven by the regional housing context bundle:
//
//   1. Headline statistics — Typical Home Value, Single Family, Condo for the
//      currently selected geography.
//   2. Typical Home Value by City — multi-line time series, 2000 → latest,
//      one line per geography (cities, counties, state, US benchmark).
//   3. Housing Type Comparison (radar) — 8-axis polygon for the active
//      geography across 1BR / 2BR / 3BR / 4BR / 5+BR / Average / Condo /
//      Single Family.
//   4. Housing Type Comparison (bars) — same eight values, vertical bars.
//   5. Typical Home Value by City Comparison — sortable bar chart across all
//      geographies. Doubles as the geography filter: clicking a bar sets the
//      active geography for the headline stats / radar / housing-type bars.
//
// Pure SVG + d3-shape / d3-scale, mirroring the rendering style used across
// the rest of the dashboard. No new dependencies.

import { useMemo, useState } from 'react';
import { line as d3Line } from 'd3-shape';
import { scaleLinear, scaleBand } from 'd3-scale';
import type {
  ContextBundle,
  ContextEnvelope,
  ContextLatest,
  ContextTrend,
  TrendPoint,
} from '../../types/context';

// ---------------------------------------------------------------------------
// Geography model
// ---------------------------------------------------------------------------
type GeoKind = 'place' | 'county' | 'state' | 'national';

interface Geography {
  id: string;
  label: string;
  kind: GeoKind;
  latest: ContextLatest | null;
  trend: ContextTrend;
}

function deriveGeographies(housing: ContextEnvelope | null): Geography[] {
  if (!housing) return [];
  const out: Geography[] = [];
  for (const p of housing.places) {
    if (p.kind === 'national') {
      out.push({ id: `national:${p.zip}`, label: p.name, kind: 'national', latest: p.latest, trend: p.trend });
    } else {
      out.push({ id: `place:${p.zip}`, label: p.name, kind: 'place', latest: p.latest, trend: p.trend });
    }
  }
  for (const c of housing.counties) {
    out.push({ id: `county:${c.geoid}`, label: c.name, kind: 'county', latest: c.latest, trend: c.trend });
  }
  if (housing.state) {
    out.push({ id: `state:${housing.state.fips}`, label: housing.state.name, kind: 'state', latest: housing.state.latest, trend: housing.state.trend });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visual tokens
// ---------------------------------------------------------------------------
// Palette tuned for the dashboard's near-black background. 16 colors covers
// the ~10 places + 4 counties + state + US benchmark superset. Geographies
// receive a stable color via index modulo palette length so the legend stays
// consistent across renders.
const GEO_PALETTE = [
  '#4FB3A9', // teal — Glenwood Springs
  '#7AC4D8', // cyan — Aspen
  '#9FB3C8', // periwinkle — Snowmass
  '#C8B273', // wheat — Basalt
  '#9CC479', // sage — Carbondale
  '#C29479', // adobe — De Beque
  '#B79CC4', // mauve — Parachute
  '#7C9DC4', // slate-blue — New Castle
  '#C47979', // brick — Rifle
  '#94C4B7', // mint — Silt
  '#FFB454', // amber accent — Garfield County
  '#A8A1C4', // lavender — Pitkin County
  '#A8C49C', // celadon — Eagle County
  '#C4A87C', // tan — Mesa County
  '#6E7280', // dim grey — Colorado
  '#9CA0A8', // lighter grey — United States
];

function geoColor(idx: number): string {
  return GEO_PALETTE[idx % GEO_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------
const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const dollarFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmtDollarsCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

function fmtDollars(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return dollarFmt.format(v);
}

// ---------------------------------------------------------------------------
// Housing-type axes (radar + bar chart)
// ---------------------------------------------------------------------------
// Order mirrors the Power BI mock: starts at 12 o'clock with Single Family,
// rotates clockwise (Condo, Average, 5+BR, 4BR, 3BR, 2BR, 1BR).
const TYPE_AXES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'zhviSfr',   label: 'Single Family' },
  { key: 'zhviCondo', label: 'Condo' },
  { key: 'zhviAvg',   label: 'Average' },
  { key: 'zhvi5br',   label: '5+ Bedroom' },
  { key: 'zhvi4br',   label: '4 Bedroom' },
  { key: 'zhvi3br',   label: '3 Bedroom' },
  { key: 'zhvi2br',   label: '2 Bedroom' },
  { key: 'zhvi1br',   label: '1 Bedroom' },
];

// The bar chart uses the same eight categories but in a more natural
// left-to-right reading order: bedroom counts ascending, then Average,
// Condo, Single Family.
const TYPE_BAR_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'zhvi1br',   label: '1 Bedroom' },
  { key: 'zhvi2br',   label: '2 Bedroom' },
  { key: 'zhvi3br',   label: '3 Bedroom' },
  { key: 'zhvi4br',   label: '4 Bedroom' },
  { key: 'zhvi5br',   label: '5+ Bedroom' },
  { key: 'zhviAvg',   label: 'Average' },
  { key: 'zhviCondo', label: 'Condo' },
  { key: 'zhviSfr',   label: 'Single Family' },
];

const TYPE_KEY_MAP: Record<string, string> = {
  zhvi1br: 'zhviBr1',
  zhvi2br: 'zhviBr2',
  zhvi3br: 'zhviBr3',
  zhvi4br: 'zhviBr4',
  zhvi5br: 'zhviBr5',
  zhviAvg: 'zhvi',
  zhviCondo: 'zhviCondo',
  zhviSfr: 'zhviSfr',
};

function typeValue(latest: ContextLatest | null, axisKey: string): number | null {
  if (!latest) return null;
  const realKey = TYPE_KEY_MAP[axisKey];
  const v = latest[realKey];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Shared chart frame (mirrors FlowCharts.ChartFrame)
// ---------------------------------------------------------------------------
function ChartFrame({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-md p-3 flex flex-col gap-2 ${className ?? ''}`}
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
      <div className="flex-1 flex flex-col">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline statistics
// ---------------------------------------------------------------------------
function HeadlineStats({ geo }: { geo: Geography | null }) {
  const latest = geo?.latest ?? null;
  const items: { label: string; value: number | null }[] = [
    { label: 'Typical Home Value', value: typeValue(latest, 'zhviAvg') },
    { label: 'Single Family',      value: typeValue(latest, 'zhviSfr') },
    { label: 'Condo',              value: typeValue(latest, 'zhviCondo') },
  ];
  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--panel-border)',
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-h)' }}
          >
            Housing Statistics
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {geo?.label ?? '—'} · Zillow ZHVI
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {items.map((it) => (
          <div key={it.label} className="flex flex-col">
            <div
              className="text-xl font-semibold tabular-nums"
              style={{ color: 'var(--text-h)' }}
            >
              {fmtDollars(it.value)}
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
              {it.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time-series chart — Typical Home Value by City
// ---------------------------------------------------------------------------
function TimeSeriesChart({
  geographies,
  activeId,
  onActivate,
}: {
  geographies: Geography[];
  activeId: string | null;
  onActivate: (id: string) => void;
}) {
  // Compute year domain + value domain across all visible series. Filters
  // out geographies that lack a 'zhvi' trend so the legend stays meaningful.
  const series = useMemo(() => {
    return geographies
      .map((g, idx) => {
        const trend = (g.trend?.zhvi ?? []).filter((p): p is TrendPoint & { value: number } => p.value != null);
        return { geo: g, color: geoColor(idx), trend };
      })
      .filter((s) => s.trend.length > 0);
  }, [geographies]);

  const { xMin, xMax, yMax } = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMax = 0;
    for (const s of series) {
      for (const p of s.trend) {
        if (p.year < xMin) xMin = p.year;
        if (p.year > xMax) xMax = p.year;
        if (p.value > yMax) yMax = p.value;
      }
    }
    if (!Number.isFinite(xMin)) xMin = 2000;
    if (!Number.isFinite(xMax)) xMax = 2024;
    return { xMin, xMax, yMax };
  }, [series]);

  // Layout — viewBox-based. The container scales the SVG to its parent.
  const W = 720;
  const H = 280;
  const M = { top: 8, right: 12, bottom: 24, left: 52 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const sx = useMemo(() => scaleLinear().domain([xMin, xMax]).range([0, innerW]), [xMin, xMax, innerW]);
  const sy = useMemo(() => scaleLinear().domain([0, yMax * 1.05 || 1]).range([innerH, 0]), [yMax, innerH]);

  const lineGen = useMemo(
    () =>
      d3Line<TrendPoint & { value: number }>()
        .x((d) => sx(d.year))
        .y((d) => sy(d.value)),
    [sx, sy],
  );

  // Y-axis ticks (round to nice $0.5M increments).
  const yTicks = useMemo(() => sy.ticks(4), [sy]);
  const xTicks = useMemo(() => {
    // 5–7 ticks across the year range, prefer multiples of 5.
    const span = xMax - xMin;
    const step = span > 20 ? 5 : span > 10 ? 2 : 1;
    const out: number[] = [];
    for (let y = Math.ceil(xMin / step) * step; y <= xMax; y += step) out.push(y);
    return out;
  }, [xMin, xMax]);

  return (
    <div className="flex flex-col gap-2">
      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s) => {
          const isActive = activeId === s.geo.id;
          return (
            <button
              key={s.geo.id}
              onClick={() => onActivate(s.geo.id)}
              className="flex items-center gap-1.5 text-[10px] tabular-nums"
              style={{
                color: isActive ? 'var(--accent)' : 'var(--text)',
                opacity: isActive || activeId == null ? 1 : 0.6,
              }}
            >
              <span
                className="inline-block rounded-full"
                style={{
                  width: 8,
                  height: 8,
                  background: s.color,
                  boxShadow: isActive ? '0 0 0 2px var(--accent-soft)' : undefined,
                }}
              />
              {s.geo.label}
            </button>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 280 }}>
        <g transform={`translate(${M.left}, ${M.top})`}>
          {/* Y gridlines + tick labels */}
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={0}
                x2={innerW}
                y1={sy(t)}
                y2={sy(t)}
                stroke="var(--panel-border)"
                strokeDasharray="2 3"
              />
              <text
                x={-6}
                y={sy(t)}
                fontSize="9"
                textAnchor="end"
                dominantBaseline="middle"
                fill="var(--text-dim)"
              >
                {fmtDollarsCompact(t)}
              </text>
            </g>
          ))}
          {/* X tick labels */}
          {xTicks.map((t) => (
            <text
              key={t}
              x={sx(t)}
              y={innerH + 14}
              fontSize="9"
              textAnchor="middle"
              fill="var(--text-dim)"
            >
              {t}
            </text>
          ))}
          {/* Series lines */}
          {series.map((s) => {
            const isActive = activeId === s.geo.id;
            const isDimmed = activeId != null && !isActive;
            const path = lineGen(s.trend) ?? '';
            return (
              <path
                key={s.geo.id}
                d={path}
                fill="none"
                stroke={isActive ? 'var(--accent)' : s.color}
                strokeWidth={isActive ? 2.4 : 1.4}
                opacity={isDimmed ? 0.32 : 0.95}
                style={{ cursor: 'pointer' }}
                onClick={() => onActivate(s.geo.id)}
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Radar chart — Housing Type Comparison
// ---------------------------------------------------------------------------
function HousingTypeRadar({ geo }: { geo: Geography | null }) {
  const values = useMemo(() => {
    return TYPE_AXES.map((a) => ({ ...a, value: typeValue(geo?.latest ?? null, a.key) }));
  }, [geo]);
  const maxVal = useMemo(() => {
    return values.reduce((m, v) => (v.value != null && v.value > m ? v.value : m), 0);
  }, [values]);

  // Wider-than-tall viewBox leaves horizontal room for labels like
  // "Single Family" on the left and "5+ Bedroom" on the right without
  // clipping at the SVG edge. Radar radius is bounded by the height.
  const W = 380;
  const H = 280;
  const cx = W / 2;
  const cy = H / 2;
  const r = H / 2 - 36;
  const n = TYPE_AXES.length;

  // Angle setup: axis 0 (1 Bedroom) at top-left, rotating clockwise so that
  // Single Family ends up at the top-right. -π/2 puts axis 0 at 12 o'clock;
  // we shift by an extra step so labels match the screenshot order.
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const point = (i: number, magnitude: number) => {
    const a = angle(i);
    const radius = maxVal > 0 ? (magnitude / maxVal) * r : 0;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;
  };
  const axisEnd = (i: number) => {
    const a = angle(i);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  const labelPoint = (i: number) => {
    const a = angle(i);
    return [cx + (r + 18) * Math.cos(a), cy + (r + 18) * Math.sin(a)] as const;
  };

  const gridLevels = [0.25, 0.5, 0.75, 1];

  // Polygon path for the data
  const polyPoints = values
    .map((v, i) => {
      const [x, y] = point(i, v.value ?? 0);
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="flex items-center justify-center w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxWidth: 380, height: 280 }}>
        {/* Concentric grid (octagons) */}
        {gridLevels.map((lvl) => {
          const pts = TYPE_AXES.map((_, i) => {
            const a = angle(i);
            return `${cx + r * lvl * Math.cos(a)},${cy + r * lvl * Math.sin(a)}`;
          }).join(' ');
          return (
            <polygon
              key={lvl}
              points={pts}
              fill="none"
              stroke="var(--panel-border)"
              strokeDasharray="2 3"
            />
          );
        })}
        {/* Axis lines */}
        {TYPE_AXES.map((_, i) => {
          const [x, y] = axisEnd(i);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--panel-border)" />;
        })}
        {/* Data polygon */}
        <polygon
          points={polyPoints}
          fill="rgba(79, 179, 169, 0.22)"
          stroke="#4FB3A9"
          strokeWidth={1.6}
        />
        {/* Data dots */}
        {values.map((v, i) => {
          const [x, y] = point(i, v.value ?? 0);
          return (
            <circle key={v.key} cx={x} cy={y} r={3} fill="#4FB3A9" />
          );
        })}
        {/* Axis labels */}
        {TYPE_AXES.map((a, i) => {
          const [x, y] = labelPoint(i);
          // Anchor based on x position so labels don't overlap the polygon.
          const anchor = x < cx - 4 ? 'end' : x > cx + 4 ? 'start' : 'middle';
          return (
            <text
              key={a.key}
              x={x}
              y={y}
              fontSize="9.5"
              textAnchor={anchor}
              dominantBaseline="middle"
              fill="var(--text)"
            >
              {a.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Housing-type bar chart — same eight categories
// ---------------------------------------------------------------------------
function HousingTypeBars({ geo }: { geo: Geography | null }) {
  const data = useMemo(() => {
    return TYPE_BAR_ORDER.map((a) => ({ ...a, value: typeValue(geo?.latest ?? null, a.key) }));
  }, [geo]);

  const W = 480;
  const H = 240;
  const M = { top: 28, right: 12, bottom: 38, left: 12 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const x = useMemo(
    () => scaleBand<string>().domain(data.map((d) => d.key)).range([0, innerW]).padding(0.18),
    [data, innerW],
  );
  const yMax = useMemo(() => data.reduce((m, d) => (d.value != null && d.value > m ? d.value : m), 0), [data]);
  const y = useMemo(() => scaleLinear().domain([0, yMax * 1.18 || 1]).range([innerH, 0]), [yMax, innerH]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 240 }}>
      <g transform={`translate(${M.left}, ${M.top})`}>
        {data.map((d) => {
          const v = d.value ?? 0;
          const xPos = x(d.key) ?? 0;
          const bw = x.bandwidth();
          const bh = innerH - y(v);
          return (
            <g key={d.key}>
              <rect
                x={xPos}
                y={y(v)}
                width={bw}
                height={Math.max(0, bh)}
                fill="#4FB3A9"
                opacity={0.85}
                rx={1}
              />
              {/* Value label on top of each bar */}
              <text
                x={xPos + bw / 2}
                y={y(v) - 4}
                fontSize="9"
                textAnchor="middle"
                fill="var(--text)"
              >
                {fmtDollarsCompact(d.value)}
              </text>
              {/* Category label under each bar */}
              <text
                x={xPos + bw / 2}
                y={innerH + 12}
                fontSize="9"
                textAnchor="middle"
                fill="var(--text-dim)"
              >
                {d.label.replace(' Bedroom', ' BR').replace('Single Family', 'Single Fam.')}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// City-comparison bar chart — sortable, doubles as the geography filter
// ---------------------------------------------------------------------------
function CityComparisonBars({
  geographies,
  activeId,
  onActivate,
}: {
  geographies: Geography[];
  activeId: string | null;
  onActivate: (id: string) => void;
}) {
  const sorted = useMemo(() => {
    return geographies
      .map((g, idx) => ({ geo: g, value: typeValue(g.latest, 'zhviAvg'), color: geoColor(idx) }))
      .filter((d) => d.value != null && Number.isFinite(d.value))
      .sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
  }, [geographies]);

  const W = 720;
  const H = 220;
  const M = { top: 24, right: 12, bottom: 56, left: 12 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const x = useMemo(
    () => scaleBand<string>().domain(sorted.map((d) => d.geo.id)).range([0, innerW]).padding(0.16),
    [sorted, innerW],
  );
  const yMax = useMemo(() => sorted.reduce((m, d) => ((d.value ?? 0) > m ? (d.value ?? 0) : m), 0), [sorted]);
  const y = useMemo(() => scaleLinear().domain([0, yMax * 1.18 || 1]).range([innerH, 0]), [yMax, innerH]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 220 }}>
      <g transform={`translate(${M.left}, ${M.top})`}>
        {sorted.map((d) => {
          const xPos = x(d.geo.id) ?? 0;
          const bw = x.bandwidth();
          const v = d.value ?? 0;
          const bh = innerH - y(v);
          const isActive = activeId === d.geo.id;
          return (
            <g key={d.geo.id} style={{ cursor: 'pointer' }} onClick={() => onActivate(d.geo.id)}>
              <rect
                x={xPos}
                y={y(v)}
                width={bw}
                height={Math.max(0, bh)}
                fill={isActive ? 'var(--accent)' : d.color}
                opacity={isActive ? 1 : 0.85}
                rx={1}
              />
              <text
                x={xPos + bw / 2}
                y={y(v) - 4}
                fontSize="9"
                textAnchor="middle"
                fill={isActive ? 'var(--accent)' : 'var(--text)'}
              >
                {fmtDollarsCompact(d.value)}
              </text>
              <g transform={`translate(${xPos + bw / 2}, ${innerH + 8})`}>
                <text
                  fontSize="9"
                  textAnchor="end"
                  fill={isActive ? 'var(--accent)' : 'var(--text-dim)'}
                  transform="rotate(-32)"
                >
                  {d.geo.label}
                </text>
              </g>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Top-level section
// ---------------------------------------------------------------------------
export function HousingMarketSection({
  bundle,
  selectedZip,
}: {
  bundle: ContextBundle | null;
  selectedZip: string | null;
}) {
  const housing = bundle?.housing ?? null;
  const geographies = useMemo(() => deriveGeographies(housing), [housing]);

  // Default the active geography to the user's current ZIP selection if it
  // resolves to a place; otherwise default to Glenwood Springs; otherwise
  // the first geography with a Typical Home Value.
  const defaultId = useMemo(() => {
    if (selectedZip) {
      const m = geographies.find((g) => g.kind === 'place' && g.id === `place:${selectedZip}`);
      if (m && typeValue(m.latest, 'zhviAvg') != null) return m.id;
    }
    const gws = geographies.find((g) => g.label === 'Glenwood Springs' && typeValue(g.latest, 'zhviAvg') != null);
    if (gws) return gws.id;
    return geographies.find((g) => typeValue(g.latest, 'zhviAvg') != null)?.id ?? null;
  }, [geographies, selectedZip]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const effectiveActiveId = activeId ?? defaultId;
  const activeGeo = useMemo(
    () => geographies.find((g) => g.id === effectiveActiveId) ?? null,
    [geographies, effectiveActiveId],
  );

  if (!housing) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
        Loading housing context…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Top row — headline statistics span full width. */}
      <HeadlineStats geo={activeGeo} />

      {/* Middle row — time series + radar */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid-cols-1">
        <ChartFrame
          title="Typical Home Value by City"
          subtitle="Zillow ZHVI · annual, 2000 → latest · click a series to focus"
        >
          <TimeSeriesChart
            geographies={geographies}
            activeId={effectiveActiveId}
            onActivate={(id) => setActiveId(id)}
          />
        </ChartFrame>

        <ChartFrame
          title="Housing Type Comparison"
          subtitle={activeGeo ? `${activeGeo.label} · radar` : 'radar'}
        >
          <HousingTypeRadar geo={activeGeo} />
        </ChartFrame>
      </div>

      {/* Bottom row — city comparison + housing-type bars */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid-cols-1">
        <ChartFrame
          title="Typical Home City Comparison"
          subtitle="Click a bar to filter the headline / radar / type chart"
        >
          <CityComparisonBars
            geographies={geographies}
            activeId={effectiveActiveId}
            onActivate={(id) => setActiveId(id)}
          />
        </ChartFrame>

        <ChartFrame
          title="Housing Type Comparison"
          subtitle={activeGeo ? `${activeGeo.label} · bars` : 'bars'}
        >
          <HousingTypeBars geo={activeGeo} />
        </ChartFrame>
      </div>
    </div>
  );
}

// Suppress unused-imports lint when intFmt is only referenced inside the
// Intl.NumberFormat instance above.
void intFmt;
