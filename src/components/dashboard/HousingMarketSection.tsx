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
export function ChartFrame({
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
// Data-set descriptor tile — anchors the left column of the Housing section
// with a plain-language explanation of what Zillow ZHVI is and how to read
// the rest of the panel. Mirrors the visual language of HeadlineStats so
// the two cards balance across the row.
// ---------------------------------------------------------------------------
function HousingDataSetTile() {
  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2"
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
          About this data
        </div>
        <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
          Zillow Home Value Index (ZHVI)
        </div>
      </div>
      <p className="text-[11px] leading-snug" style={{ color: 'var(--text)' }}>
        ZHVI is a smoothed, seasonally adjusted measure of typical home value
        across a region and housing type. It reflects the 35th–65th percentile
        of homes — neither the cheapest nor the most expensive — so it tracks
        the value of a middle-of-the-market home rather than a sale-price
        average skewed by listings at the extremes.
      </p>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1">
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Source
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>Zillow Research</span>
        </li>
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Metric
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>ZHVI ($USD)</span>
        </li>
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Cadence
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>Monthly · annualized</span>
        </li>
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Coverage
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>2000 → latest</span>
        </li>
      </ul>
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
  highlightId,
  onActivate,
  typeKey = 'zhviAvg',
}: {
  geographies: Geography[];
  // Non-null when the user has clicked a city — narrows the rendered set
  // to ONLY that city's line. Null = render all cities.
  activeId: string | null;
  // Which city is visually highlighted in the legend / dots / tooltip.
  // Falls back to the section's default city even when no filter is
  // active, so the legend still shows a primary anchor.
  highlightId: string | null;
  onActivate: (id: string) => void;
  // Trend metric key (matches TYPE_AXES.key). Default is the average
  // ZHVI trend; passing 'zhviSfr', 'zhvi3br', etc. retargets every line
  // onto that housing-type's trend.
  typeKey?: string;
}) {
  // Compute year domain + value domain across all visible series. Filters
  // out geographies that lack a trend for the active type key so the
  // legend stays meaningful. When activeId is set we additionally filter
  // to that city — clicking a bar in the city-comparison chart narrows
  // the time series to a single line.
  const series = useMemo(() => {
    const trendKey = TYPE_KEY_MAP[typeKey] ?? 'zhvi';
    return geographies
      .map((g, idx) => {
        const trend = (g.trend?.[trendKey] ?? []).filter((p): p is TrendPoint & { value: number } => p.value != null);
        return { geo: g, color: geoColor(idx), trend };
      })
      .filter((s) => s.trend.length > 0)
      .filter((s) => activeId == null || s.geo.id === activeId);
  }, [geographies, typeKey, activeId]);

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

  // Hover state — year currently focused by the user's cursor. The tooltip
  // surfaces the value for every visible series at that year.
  const [hoverYear, setHoverYear] = useState<number | null>(null);

  // Map a viewBox-space x coord (within plot bounds) → nearest integer year
  // that has data on at least one series. Snapping keeps the tooltip aligned
  // with the actual data points instead of interpolating between them.
  const allYears = useMemo(() => {
    const set = new Set<number>();
    for (const s of series) for (const p of s.trend) set.add(p.year);
    return Array.from(set).sort((a, b) => a - b);
  }, [series]);

  const xToYear = (xViewBox: number): number | null => {
    if (allYears.length === 0) return null;
    const xData = sx.invert(xViewBox);
    let best = allYears[0];
    let bestDist = Math.abs(allYears[0] - xData);
    for (let i = 1; i < allYears.length; i++) {
      const d = Math.abs(allYears[i] - xData);
      if (d < bestDist) { bestDist = d; best = allYears[i]; }
    }
    return best;
  };

  const handleMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    const xInPlot = local.x - M.left;
    if (xInPlot < 0 || xInPlot > innerW) return;
    const yr = xToYear(xInPlot);
    if (yr != null) setHoverYear(yr);
  };

  // Per-series value at the focused year (used for the dots + tooltip rows).
  const focused = useMemo(() => {
    if (hoverYear == null) return null;
    const rows = series
      .map((s) => {
        const pt = s.trend.find((p) => p.year === hoverYear);
        if (!pt) return null;
        return { geo: s.geo, color: s.color, value: pt.value };
      })
      .filter((x): x is { geo: Geography; color: string; value: number } => x != null)
      .sort((a, b) => b.value - a.value);
    if (rows.length === 0) return null;
    return { year: hoverYear, rows };
  }, [hoverYear, series]);

  // Tooltip x in % of viewBox so the floating HTML label can absolutely
  // position itself relative to the SVG container.
  const tooltipPct = useMemo(() => {
    if (!focused) return null;
    const cx = M.left + sx(focused.year);
    return { left: (cx / W) * 100 };
  }, [focused, sx, M.left]);

  return (
    <div className="flex flex-col gap-2 flex-1">
      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {series.map((s) => {
          const isActive = highlightId === s.geo.id;
          return (
            <button
              key={s.geo.id}
              onClick={() => onActivate(s.geo.id)}
              className="flex items-center gap-1.5 text-[10px] tabular-nums"
              style={{
                color: isActive ? 'var(--accent)' : 'var(--text)',
                opacity: isActive || highlightId == null ? 1 : 0.6,
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
      <div className="relative w-full flex-1 flex flex-col" style={{ minHeight: 240 }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full h-full"
          style={{ display: 'block', flex: 1, minHeight: 200 }}
          onMouseLeave={() => setHoverYear(null)}
        >
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
              const isActive = highlightId === s.geo.id;
              const isDimmed = highlightId != null && !isActive;
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
            {/* Hover guide + per-series dots */}
            {focused && (
              <g>
                <line
                  x1={sx(focused.year)}
                  x2={sx(focused.year)}
                  y1={0}
                  y2={innerH}
                  stroke="var(--accent)"
                  strokeOpacity={0.5}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
                {focused.rows.map((r) => (
                  <circle
                    key={r.geo.id}
                    cx={sx(focused.year)}
                    cy={sy(r.value)}
                    r={3}
                    fill={highlightId === r.geo.id ? 'var(--accent)' : r.color}
                    stroke="rgba(11,13,16,0.95)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            )}
            {/* Transparent capture rect for hover events */}
            <rect
              x={0}
              y={0}
              width={innerW}
              height={innerH}
              fill="transparent"
              pointerEvents="all"
              onMouseMove={handleMove}
            />
          </g>
        </svg>
        {/* Floating tooltip — multi-series at the focused year. Sorted
            descending by value so the user reads the leaderboard from the
            top down. */}
        {focused && tooltipPct && (
          <div
            className="pointer-events-none absolute rounded-md px-2 py-1.5 text-[10px]"
            style={{
              left: `${Math.min(95, Math.max(5, tooltipPct.left))}%`,
              top: 4,
              transform: 'translateX(-50%)',
              background: 'rgba(11, 13, 16, 0.94)',
              border: '1px solid var(--panel-border)',
              color: 'var(--text-h)',
              whiteSpace: 'nowrap',
              lineHeight: 1.4,
              maxHeight: 'calc(100% - 8px)',
              overflowY: 'auto',
            }}
          >
            <div
              className="text-[10px] mb-0.5 pb-0.5"
              style={{
                color: 'var(--text-dim)',
                borderBottom: '1px solid var(--panel-border)',
              }}
            >
              {focused.year}
            </div>
            <ul className="flex flex-col gap-0.5">
              {focused.rows.slice(0, 8).map((r) => {
                const isActive = highlightId === r.geo.id;
                return (
                  <li
                    key={r.geo.id}
                    className="flex items-center gap-2 justify-between"
                    style={{ color: isActive ? 'var(--accent)' : 'var(--text)' }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block rounded-full"
                        style={{ width: 6, height: 6, background: r.color }}
                      />
                      {r.geo.label}
                    </span>
                    <span className="tnum" style={{ color: 'var(--text-h)' }}>
                      {fmtDollarsCompact(r.value)}
                    </span>
                  </li>
                );
              })}
              {focused.rows.length > 8 && (
                <li className="text-[9px]" style={{ color: 'var(--text-dim)' }}>
                  + {focused.rows.length - 8} more
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Radar chart — Housing Type Comparison
// ---------------------------------------------------------------------------
function HousingTypeRadar({
  geo,
  selectedTypeKey,
  onSelectType,
}: {
  geo: Geography | null;
  selectedTypeKey?: string | null;
  onSelectType?: (key: string) => void;
}) {
  const values = useMemo(() => {
    return TYPE_AXES.map((a) => ({ ...a, value: typeValue(geo?.latest ?? null, a.key) }));
  }, [geo]);
  const maxVal = useMemo(() => {
    return values.reduce((m, v) => (v.value != null && v.value > m ? v.value : m), 0);
  }, [values]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

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

  // Tooltip metrics — positioned in the SVG's viewBox coordinate space so
  // the placement scales with the chart. Pinned slightly above the hovered
  // dot, with overflow handling at the SVG edges.
  const hover = hoverIdx != null ? values[hoverIdx] : null;
  const hoverPoint = hoverIdx != null ? point(hoverIdx, hover?.value ?? 0) : null;
  const tipW = 120;
  const tipH = 32;
  let tipX = 0;
  let tipY = 0;
  if (hoverPoint) {
    tipX = Math.min(W - tipW - 4, Math.max(4, hoverPoint[0] - tipW / 2));
    tipY = Math.max(4, hoverPoint[1] - tipH - 12);
  }

  return (
    <div className="flex flex-1 items-center justify-center w-full h-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full mx-auto block"
        style={{ maxWidth: 380, maxHeight: 320 }}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Housing type comparison radar"
      >
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
        {/* Data dots — invisible larger hit-target sits below each
            visible dot so hover doesn't require pixel-perfect aim, and
            clicks toggle the section's selected housing type. */}
        {values.map((v, i) => {
          const [x, y] = point(i, v.value ?? 0);
          const active = hoverIdx === i;
          const selected = selectedTypeKey === v.key;
          return (
            <g key={v.key}>
              <circle
                cx={x}
                cy={y}
                r={12}
                fill="transparent"
                style={{ cursor: onSelectType ? 'pointer' : 'default' }}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => onSelectType?.(v.key)}
              />
              <circle
                cx={x}
                cy={y}
                r={selected ? 6 : active ? 5 : 3}
                fill={selected ? 'var(--accent)' : '#4FB3A9'}
                stroke={selected || active ? 'var(--text-h)' : 'none'}
                strokeWidth={selected ? 1.5 : active ? 1 : 0}
                pointerEvents="none"
              />
            </g>
          );
        })}
        {/* Axis labels */}
        {TYPE_AXES.map((a, i) => {
          const [x, y] = labelPoint(i);
          // Anchor based on x position so labels don't overlap the polygon.
          const anchor = x < cx - 4 ? 'end' : x > cx + 4 ? 'start' : 'middle';
          const selected = selectedTypeKey === a.key;
          return (
            <text
              key={a.key}
              x={x}
              y={y}
              fontSize="9.5"
              textAnchor={anchor}
              dominantBaseline="middle"
              fill={selected ? 'var(--accent)' : 'var(--text)'}
              fontWeight={selected ? 600 : 400}
              style={{ cursor: onSelectType ? 'pointer' : 'default' }}
              onClick={() => onSelectType?.(a.key)}
            >
              {a.label}
            </text>
          );
        })}
        {/* Tooltip — rendered last so it sits above all other layers. */}
        {hover && hoverPoint && (
          <g pointerEvents="none">
            <rect
              x={tipX}
              y={tipY}
              width={tipW}
              height={tipH}
              rx={4}
              ry={4}
              fill="rgba(15, 18, 24, 0.95)"
              stroke="var(--panel-border)"
              strokeWidth={1}
            />
            <text
              x={tipX + tipW / 2}
              y={tipY + 12}
              fontSize="9"
              textAnchor="middle"
              fill="var(--text-dim)"
            >
              {hover.label}
            </text>
            <text
              x={tipX + tipW / 2}
              y={tipY + 24}
              fontSize="11"
              fontWeight={600}
              textAnchor="middle"
              fill="var(--text-h)"
            >
              {fmtDollarsCompact(hover.value)}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Housing-type bar chart — same eight categories
// ---------------------------------------------------------------------------
function HousingTypeBars({
  geo,
  selectedTypeKey,
  onSelectType,
}: {
  geo: Geography | null;
  selectedTypeKey?: string | null;
  onSelectType?: (key: string) => void;
}) {
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

  // Value-based gradient: bars darken as their value increases. Map the
  // smallest non-null value to a light teal and the largest to a deep
  // teal, interpolating linearly in HSL-ish RGB space.
  const yMin = useMemo(
    () => data.reduce(
      (m, d) => (d.value != null && (m == null || d.value < m) ? d.value : m),
      null as number | null,
    ),
    [data],
  );
  const colorForValue = (v: number | null): string => {
    if (v == null || yMax <= 0) return '#4FB3A9';
    const lo = yMin ?? v;
    const span = Math.max(1, yMax - lo);
    const t = Math.min(1, Math.max(0, (v - lo) / span));
    // Light end (low value): pale teal #B8E3DE
    // Dark end (high value): deep teal #1F6B62
    const lerp = (a: number, b: number) => Math.round(a + (b - a) * t);
    const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
    return rgb(lerp(0xB8, 0x1F), lerp(0xE3, 0x6B), lerp(0xDE, 0x62));
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 240 }}>
      <g transform={`translate(${M.left}, ${M.top})`}>
        {data.map((d) => {
          const v = d.value ?? 0;
          const xPos = x(d.key) ?? 0;
          const bw = x.bandwidth();
          const bh = innerH - y(v);
          const selected = selectedTypeKey === d.key;
          return (
            <g
              key={d.key}
              style={{ cursor: onSelectType ? 'pointer' : 'default' }}
              onClick={() => onSelectType?.(d.key)}
            >
              {/* Hit-target — full column so the user can click anywhere
                  in the bar's column band, not just on the colored bar. */}
              <rect
                x={xPos}
                y={0}
                width={bw}
                height={innerH}
                fill="transparent"
                pointerEvents="all"
              />
              <rect
                x={xPos}
                y={y(v)}
                width={bw}
                height={Math.max(0, bh)}
                fill={colorForValue(d.value)}
                opacity={selected ? 1 : 0.95}
                stroke={selected ? 'var(--accent)' : 'none'}
                strokeWidth={selected ? 2 : 0}
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
  typeKey = 'zhviAvg',
}: {
  geographies: Geography[];
  activeId: string | null;
  onActivate: (id: string) => void;
  // Which housing-type metric drives the bar lengths. Defaults to the
  // average ZHVI; switching to 'zhviSfr', 'zhvi3br', etc. retargets the
  // ranking to that type so the section can pivot on housing type.
  typeKey?: string;
}) {
  const sorted = useMemo(() => {
    return geographies
      .map((g, idx) => ({ geo: g, value: typeValue(g.latest, typeKey), color: geoColor(idx) }))
      .filter((d) => d.value != null && Number.isFinite(d.value))
      .sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
  }, [geographies, typeKey]);

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
  // Selected housing type (null = use the average ZHVI metric). When set,
  // the time-series chart and the city-comparison chart both retarget to
  // this metric so the user can pivot the section between Average,
  // Single Family, Condo, or any of the bedroom buckets.
  const [selectedTypeKey, setSelectedTypeKey] = useState<string | null>(null);
  const typeKey = selectedTypeKey ?? 'zhviAvg';
  const typeLabel = useMemo(
    () => TYPE_AXES.find((t) => t.key === typeKey)?.label ?? 'Average',
    [typeKey],
  );
  // Toggle handlers — clicking the active selection clears it back to the
  // default. Mirrors the segmented-control style cross-filter the user
  // expects from the rankings panel.
  const handleSelectCity = (id: string) => {
    setActiveId((prev) => (prev === id ? null : id));
  };
  const handleSelectType = (key: string) => {
    setSelectedTypeKey((prev) => (prev === key ? null : key));
  };

  if (!housing) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
        Loading housing context…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Top section is split into two row-grids that share a column
          template, so paired cards (About ↔ Stats, Chart ↔ Radar) match
          heights via CSS grid's default stretch alignment. The 2nd row
          uses items-stretch + flex-1 inside ChartFrame so the chart and
          radar SVGs grow to fill the row. */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid-cols-1">
        <HousingDataSetTile />
        <HeadlineStats geo={activeGeo} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid-cols-1 items-stretch">
        <ChartFrame
          title="Typical Home Value by City"
          subtitle={`Zillow ZHVI · ${typeLabel} · annual, 2000 → latest · hover for values${activeId ? ` · filtered to ${activeGeo?.label ?? ''}` : ''}`}
        >
          <TimeSeriesChart
            geographies={geographies}
            activeId={activeId}
            highlightId={effectiveActiveId}
            onActivate={handleSelectCity}
            typeKey={typeKey}
          />
        </ChartFrame>

        <ChartFrame
          title="Housing Type Comparison"
          subtitle={activeGeo ? `${activeGeo.label} · radar · click an axis to pivot` : 'radar'}
        >
          <HousingTypeRadar
            geo={activeGeo}
            selectedTypeKey={selectedTypeKey}
            onSelectType={handleSelectType}
          />
        </ChartFrame>
      </div>

      {/* Bottom row — city comparison + housing-type bars (unchanged) */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] grid-cols-1">
        <ChartFrame
          title="Typical Home City Comparison"
          subtitle={`Click a bar to filter the time series · metric: ${typeLabel}`}
        >
          <CityComparisonBars
            geographies={geographies}
            activeId={effectiveActiveId}
            onActivate={handleSelectCity}
            typeKey={typeKey}
          />
        </ChartFrame>

        <ChartFrame
          title="Housing Type Comparison"
          subtitle={activeGeo ? `${activeGeo.label} · bars · click to pivot` : 'bars'}
        >
          <HousingTypeBars
            geo={activeGeo}
            selectedTypeKey={selectedTypeKey}
            onSelectType={handleSelectType}
          />
        </ChartFrame>
      </div>
    </div>
  );
}

// Suppress unused-imports lint when intFmt is only referenced inside the
// Intl.NumberFormat instance above.
void intFmt;
