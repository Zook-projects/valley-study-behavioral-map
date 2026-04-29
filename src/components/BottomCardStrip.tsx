// BottomCardStrip — horizontally-scrolling LODES card strip pinned to the
// bottom of the map area. Switches between an aggregate view (no ZIP
// selected — sums every anchor) and a per-anchor view (ZIP selected — shows
// that anchor's blocks plus the two OD partner cards).
//
// Trend sparklines use d3-shape's line generator over the 22-vintage
// 2002–2023 series shipped in rac.json / wac.json / od-summary.json.
// Latest-year tile values are highlighted; trend axis is unlabeled by design
// (the strip is a glanceable companion to the map, not a stats deliverable).

import {
  area as d3Area,
  arc as d3Arc,
  line as d3Line,
  pie as d3Pie,
  type PieArcDatum,
} from 'd3-shape';
import { useId, useMemo, useRef, useState } from 'react';
import { fmtInt, fmtPct } from '../lib/format';
import type {
  AgeBlock,
  Naics3Block,
  OdAggregate,
  OdPartner,
  OdSummaryEntry,
  OdSummaryFile,
  RacFile,
  RacWacAggregate,
  RacWacLatest,
  RacWacTrend,
  TrendPoint,
  WacFile,
  WageBlock,
} from '../types/lodes';
import type {
  ActiveCorridorAggregation,
  CorridorFlowEntry,
  CorridorId,
  CorridorRecord,
  FlowRow,
  Mode,
  SegmentFilter,
  ZipMeta,
} from '../types/flow';
import {
  buildVisibleCorridorMap,
} from '../lib/corridors';
import {
  filteredLatestTotal,
  filteredOdLatestTotal,
  filteredTrendSeries,
  isSegmentFilterAll,
  meanCommuteMiles,
  type DriveDistanceMap,
} from '../lib/flowQueries';
import { SegmentFilterPanel } from './SegmentFilterPanel';

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------
// SVG is rendered with width=100% so it stretches to fill its container; the
// viewBox below defines the internal coordinate space. preserveAspectRatio
// "none" lets the line scale horizontally with the card while keeping the
// fixed pixel height. The line is constrained to the top band (LINE_BAND_H);
// the gradient area extends from the line down to SPARK_VB_H so the fill
// fades out into the empty card space below.
const SPARK_VB_W = 200;
const SPARK_VB_H = 84;
const LINE_BAND_H = 38;

// ---------------------------------------------------------------------------
// Shared sparkline hover plumbing
// ---------------------------------------------------------------------------
// All sparklines share the same hover behavior: track the cursor's x position
// over the wrapper, snap to the nearest year in the union of every series,
// then render a vertical guide line, a colored dot per series at that year,
// and a small floating tooltip listing variable name / year / value. Single-
// and multi-series charts use the same helpers below.

interface HoverState {
  yearIdx: number; // index into the canonical years array
  clientX: number; // mouse x relative to wrapper, for tooltip positioning
}

// Build the union of years across all series, sorted ascending.
function unionYears(seriesList: TrendPoint[][]): number[] {
  const set = new Set<number>();
  for (const s of seriesList) for (const p of s) set.add(p.year);
  return Array.from(set).sort((a, b) => a - b);
}

// Hover handlers that map cursor → nearest year via the wrapper's bounding
// rect. The wrapper element is captured in a ref so the math stays accurate
// regardless of scroll/layout shifts.
function makeHoverHandlers(
  wrapperRef: React.RefObject<HTMLDivElement | null>,
  years: number[],
  setHover: (h: HoverState | null) => void,
) {
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapperRef.current;
    if (!el || years.length === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = e.clientX - rect.left;
    const t = Math.max(0, Math.min(1, x / rect.width));
    const idx = Math.round(t * (years.length - 1));
    setHover({ yearIdx: idx, clientX: x });
  };
  const onLeave = () => setHover(null);
  return { onMove, onLeave };
}

// Tooltip card rendered above the cursor. Lists the year header followed by
// one row per series with a color swatch, label, and value.
function HoverTooltip({
  year,
  rows,
  x,
  containerWidth,
}: {
  year: number;
  rows: { name: string; value: number; color: string }[];
  x: number;
  containerWidth: number;
}) {
  // Pin the tooltip inside the wrapper bounds — flip to the left of the
  // cursor when it would overflow the right edge.
  const TOOLTIP_W = 130;
  const flip = x + TOOLTIP_W + 8 > containerWidth;
  const left = flip ? Math.max(0, x - TOOLTIP_W - 8) : x + 8;
  return (
    <div
      className="glass absolute rounded-md px-2 py-1.5 text-[10px] pointer-events-none z-10"
      style={{
        left,
        bottom: '100%',
        marginBottom: 4,
        width: TOOLTIP_W,
      }}
    >
      <div className="font-semibold tnum mb-1" style={{ color: '#ffffff' }}>
        {year}
      </div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-1.5 leading-tight">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: r.color }}
          />
          <span className="truncate" style={{ color: '#ffffff' }}>
            {r.name}
          </span>
          <span className="ml-auto tnum" style={{ color: '#ffffff' }}>
            {fmtInt(r.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Sparkline({
  series,
  yDomain,
  color = 'var(--text-h)',
  dotColor = 'var(--accent)',
  fill = false,
  name = 'Value',
}: {
  series: TrendPoint[];
  // Optional shared y-axis domain. When provided, all sparklines using the
  // same domain are visually comparable (e.g., the OD trio at the bottom of
  // the strip). When omitted, the sparkline auto-fits to its own series.
  yDomain?: [number, number];
  // Stroke + gradient base color for this line. Defaults to body text.
  color?: string;
  // Latest-value dot color. Defaults to the amber accent.
  dotColor?: string;
  // When true, the SVG fills its parent vertically (100% height) instead
  // of rendering at a fixed pixel height.
  fill?: boolean;
  // Series label shown in the hover tooltip.
  name?: string;
}) {
  const gradId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const geometry = useMemo(() => {
    if (series.length < 2) return null;
    const xs = series.map((p) => p.year);
    const ys = series.map((p) => p.value);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = yDomain ? yDomain[0] : Math.min(...ys);
    const yMax = yDomain ? yDomain[1] : Math.max(...ys);
    const xSpan = xMax - xMin || 1;
    const ySpan = yMax - yMin || 1;
    const sx = (x: number) => ((x - xMin) / xSpan) * (SPARK_VB_W - 4) + 2;
    const sy = (y: number) =>
      LINE_BAND_H - 4 - ((y - yMin) / ySpan) * (LINE_BAND_H - 8);
    const linePath = d3Line<TrendPoint>()
      .x((d) => sx(d.year))
      .y((d) => sy(d.value))(series) ?? '';
    const areaPath = d3Area<TrendPoint>()
      .x((d) => sx(d.year))
      .y0(SPARK_VB_H)
      .y1((d) => sy(d.value))(series) ?? '';
    const last = series[series.length - 1];
    return {
      linePath,
      areaPath,
      lastX: sx(last.year),
      lastY: sy(last.value),
      xMin,
      xMax,
      lastValue: last.value,
      sx,
      sy,
    };
  }, [series, yDomain]);

  const years = useMemo(() => series.map((p) => p.year), [series]);
  const hoverHandlers = useMemo(
    () => makeHoverHandlers(wrapperRef, years, setHover),
    [years],
  );

  if (!geometry) return null;

  const hoveredPoint =
    hover && years.length > 0 ? series[Math.min(hover.yearIdx, series.length - 1)] : null;

  // The SVG uses preserveAspectRatio="none" so the chart line stretches to
  // fill the card horizontally — but that would also squash any <circle>
  // drawn inside it into an oval. We render the latest-value dot as a
  // separately positioned HTML element overlaid on the SVG so it stays a
  // perfect circle regardless of card aspect ratio.
  return (
    <div
      ref={wrapperRef}
      className="relative w-full"
      style={{ height: fill ? '100%' : SPARK_VB_H }}
      onMouseMove={hoverHandlers.onMove}
      onMouseLeave={hoverHandlers.onLeave}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SPARK_VB_W} ${SPARK_VB_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Trend ${geometry.xMin}–${geometry.xMax}, latest ${fmtInt(geometry.lastValue)}`}
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geometry.areaPath} fill={`url(#${gradId})`} stroke="none" />
        <path
          d={geometry.linePath}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hoveredPoint && (
          <line
            x1={geometry.sx(hoveredPoint.year)}
            x2={geometry.sx(hoveredPoint.year)}
            y1={0}
            y2={SPARK_VB_H}
            stroke="var(--text-dim)"
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
            opacity={0.6}
          />
        )}
      </svg>
      <span
        aria-hidden
        className="absolute rounded-full pointer-events-none"
        style={{
          left: `${(geometry.lastX / SPARK_VB_W) * 100}%`,
          top: `${(geometry.lastY / SPARK_VB_H) * 100}%`,
          width: 6,
          height: 6,
          background: dotColor,
          transform: 'translate(-50%, -50%)',
        }}
      />
      {hoveredPoint && (
        <span
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            left: `${(geometry.sx(hoveredPoint.year) / SPARK_VB_W) * 100}%`,
            top: `${(geometry.sy(hoveredPoint.value) / SPARK_VB_H) * 100}%`,
            width: 6,
            height: 6,
            background: color,
            border: '1px solid var(--text-h)',
            transform: 'translate(-50%, -50%)',
          }}
        />
      )}
      {hover && hoveredPoint && wrapperRef.current && (
        <HoverTooltip
          year={hoveredPoint.year}
          rows={[{ name, value: hoveredPoint.value, color: dotColor }]}
          x={hover.clientX}
          containerWidth={wrapperRef.current.getBoundingClientRect().width}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card chrome
// ---------------------------------------------------------------------------
function Card({
  title,
  subtitle,
  children,
  width = 220,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      className="glass rounded-md p-3 shrink-0 flex flex-col gap-2"
      style={{ width }}
    >
      <div>
        <div
          className="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          {title}
        </div>
        {subtitle && (
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
            {subtitle}
          </div>
        )}
      </div>
      <div className="flex-1 flex flex-col gap-1 min-h-0">{children}</div>
    </div>
  );
}

function HeadlineNumber({ value }: { value: number }) {
  return (
    <div
      className="text-lg font-semibold tnum leading-tight"
      style={{ color: 'var(--text-h)' }}
    >
      {fmtInt(value)}
    </div>
  );
}

// Section header used inside a multi-section card (e.g., the combined
// "Workforce mix" tile that stacks Age / Wages / Industry breakdowns).
function BreakdownSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-h)' }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// Tiny three-row breakdown block — used by age/wage/naics/race/education etc.
function Breakdown({ rows, total }: { rows: { label: string; value: number }[]; total: number }) {
  const denom = total || rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <table className="w-full text-[11px] tnum table-fixed">
      {/* Fixed value/percent column widths so the numeric columns line up
          across the three sections of the Workforce mix card. */}
      <colgroup>
        <col />
        <col style={{ width: 64 }} />
        <col style={{ width: 48 }} />
      </colgroup>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className="pl-3 pr-2" style={{ color: 'var(--text-dim)' }}>{r.label}</td>
            <td className="text-right pr-2" style={{ color: 'var(--text-h)' }}>
              {fmtInt(r.value)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(r.value / denom)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Card content helpers
// ---------------------------------------------------------------------------
function ageRows(b: AgeBlock) {
  return [
    { label: 'Under 30', value: b.u29 },
    { label: '30 – 54', value: b.age30to54 },
    { label: '55 +', value: b.age55plus },
  ];
}
function wageRows(b: WageBlock) {
  return [
    { label: '≤ $1,250/mo', value: b.low },
    { label: '$1,251 – $3,333', value: b.mid },
    { label: '> $3,333/mo', value: b.high },
  ];
}
function naicsRows(b: Naics3Block) {
  return [
    { label: 'Goods', value: b.goods },
    { label: 'Trade · Trans · Util', value: b.tradeTransUtil },
    { label: 'All other services', value: b.allOther },
  ];
}
// ---------------------------------------------------------------------------
// Aggregate workforce-mix charts — only used when no ZIP is selected.
// Per-anchor view keeps the original three-section breakdown table.
// ---------------------------------------------------------------------------

// Shared hover state shape for the three aggregate charts: which row index
// is being hovered + the cursor position relative to the chart's wrapper
// (used to position the floating tooltip).
interface ChartHoverState {
  idx: number;
  x: number;
  y: number;
}

// Tooltip rendered absolutely-positioned inside the chart's relative wrapper.
// Mirrors the sparkline HoverTooltip styling (glass panel, swatch, label,
// value, percent) so all charts in the strip share a single visual language.
function ChartTooltip({
  label,
  value,
  pct,
  swatchColor,
  x,
  y,
  containerWidth,
}: {
  label: string;
  value: number;
  pct: number;
  swatchColor: string;
  x: number;
  y: number;
  containerWidth: number;
}) {
  const TOOLTIP_W = 140;
  const flip = x + TOOLTIP_W + 8 > containerWidth;
  const left = flip ? Math.max(0, x - TOOLTIP_W - 8) : x + 8;
  const top = Math.max(0, y - 36);
  return (
    <div
      className="glass absolute rounded-md px-2 py-1.5 text-[10px] pointer-events-none z-10"
      style={{ left, top, width: TOOLTIP_W }}
    >
      <div className="flex items-center gap-1.5 leading-tight">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: swatchColor }}
        />
        <span className="truncate" style={{ color: '#ffffff' }}>
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="font-semibold tnum" style={{ color: '#ffffff' }}>
          {fmtInt(value)}
        </span>
        <span className="tnum" style={{ color: '#ffffff' }}>
          {fmtPct(pct)}
        </span>
      </div>
    </div>
  );
}

// Vertical bar chart used for the aggregate Age card. Bars are scaled to the
// largest cohort in the block so the dominant 30–54 bar reaches the top of
// the plot area; shorter cohorts read as relative proportions of that peak.
// Color treatment is "shades of white" — pure white grading down to a dimmer
// off-white so bars stay legible on the dark glass card background.
function AgeBarChart({ rows, total }: { rows: { label: string; value: number }[]; total: number }) {
  const denom = total || rows.reduce((s, r) => s + r.value, 0) || 1;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const colors = ['rgba(255,255,255,1)', 'rgba(255,255,255,0.72)', 'rgba(255,255,255,0.46)'];
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const onMove = (idx: number) => (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setHover({ idx, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  return (
    <div ref={wrapperRef} className="relative flex flex-col gap-2">
      <div className="flex items-end justify-around gap-2 h-24">
        {rows.map((r, i) => {
          const h = (r.value / max) * 100;
          return (
            <div
              key={r.label}
              className="flex flex-col items-center justify-end flex-1 h-full gap-1 cursor-default"
              onMouseMove={onMove(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="text-[10px] tnum" style={{ color: 'var(--text-h)' }}>
                {fmtInt(r.value)}
              </div>
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${h}%`,
                  background: colors[i] ?? colors[colors.length - 1],
                  minHeight: 2,
                  outline: hover?.idx === i ? '1px solid var(--text-h)' : 'none',
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-around gap-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex-1 text-center text-[10px]"
            style={{ color: 'var(--text-dim)' }}
          >
            {r.label}
            <div className="tnum" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(r.value / denom)}
            </div>
          </div>
        ))}
      </div>
      {hover && wrapperRef.current && (
        <ChartTooltip
          label={rows[hover.idx].label}
          value={rows[hover.idx].value}
          pct={rows[hover.idx].value / denom}
          swatchColor={colors[hover.idx] ?? colors[colors.length - 1]}
          x={hover.x}
          y={hover.y}
          containerWidth={wrapperRef.current.getBoundingClientRect().width}
        />
      )}
    </div>
  );
}

// Horizontal bar chart used for the aggregate Wages card. Each bar takes a
// row; bar length scales relative to the largest tier (>$3,333/mo, in
// practice). Color treatment is shades of grey — light to dark to evoke the
// "low / mid / high" ramp without competing with the amber accent.
function WageBarChart({ rows, total }: { rows: { label: string; value: number }[]; total: number }) {
  const denom = total || rows.reduce((s, r) => s + r.value, 0) || 1;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const colors = ['#d0d0d0', '#9a9a9a', '#6a6a6a'];
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const onMove = (idx: number) => (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setHover({ idx, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  return (
    <div ref={wrapperRef} className="relative flex flex-col gap-2">
      {rows.map((r, i) => {
        const w = (r.value / max) * 100;
        return (
          <div
            key={r.label}
            className="flex flex-col gap-0.5 cursor-default"
            onMouseMove={onMove(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="flex items-baseline justify-between text-[10px]">
              <span style={{ color: 'var(--text-dim)' }}>{r.label}</span>
              <span className="tnum flex items-baseline gap-2">
                <span style={{ color: 'var(--text-h)' }}>{fmtInt(r.value)}</span>
                <span style={{ color: 'var(--text-dim)' }}>{fmtPct(r.value / denom)}</span>
              </span>
            </div>
            <div className="w-full h-2 rounded-sm" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${w}%`,
                  background: colors[i] ?? colors[colors.length - 1],
                  minWidth: 2,
                  outline: hover?.idx === i ? '1px solid var(--text-h)' : 'none',
                }}
              />
            </div>
          </div>
        );
      })}
      {hover && wrapperRef.current && (
        <ChartTooltip
          label={rows[hover.idx].label}
          value={rows[hover.idx].value}
          pct={rows[hover.idx].value / denom}
          swatchColor={colors[hover.idx] ?? colors[colors.length - 1]}
          x={hover.x}
          y={hover.y}
          containerWidth={wrapperRef.current.getBoundingClientRect().width}
        />
      )}
    </div>
  );
}

// Pie chart used for the aggregate Industry · NAICS-3 card. Three slices
// (Goods / Trade·Trans·Util / All other services) drawn with d3-shape. The
// "all other services" slice gets the amber accent because it's the
// dominant category and the editorial focal point; goods + trade are
// rendered as white and grey respectively.
function NaicsPieChart({ rows, total }: { rows: { label: string; value: number }[]; total: number }) {
  const denom = total || rows.reduce((s, r) => s + r.value, 0) || 1;
  const colors = ['#ffffff', '#888888', 'var(--accent)'];
  const size = 96;
  const radius = size / 2;
  const innerRadius = radius * 0.45; // donut hole, keeps the small slices legible
  const pieGen = d3Pie<{ label: string; value: number }>()
    .value((d) => d.value)
    .sort(null);
  const arcGen = d3Arc<PieArcDatum<{ label: string; value: number }>>()
    .innerRadius(innerRadius)
    .outerRadius(radius);
  const slices = pieGen(rows);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ChartHoverState | null>(null);
  const onSliceMove = (idx: number) => (e: React.MouseEvent<SVGPathElement | HTMLDivElement>) => {
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setHover({ idx, x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  return (
    <div ref={wrapperRef} className="relative flex items-center gap-3">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Industry mix pie chart">
        <g transform={`translate(${radius}, ${radius})`}>
          {slices.map((s, i) => (
            <path
              key={s.data.label}
              d={arcGen(s) ?? ''}
              fill={colors[i] ?? colors[colors.length - 1]}
              stroke="var(--bg)"
              strokeWidth={hover?.idx === i ? 2 : 1}
              opacity={hover && hover.idx !== i ? 0.55 : 1}
              style={{ cursor: 'default' }}
              onMouseMove={onSliceMove(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </g>
      </svg>
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className="flex items-center gap-1.5 text-[10px] leading-tight cursor-default"
            onMouseMove={onSliceMove(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              className="inline-block w-2 h-2 rounded-sm shrink-0"
              style={{ background: colors[i] ?? colors[colors.length - 1] }}
            />
            <span className="truncate" style={{ color: 'var(--text-dim)' }}>
              {r.label}
            </span>
            <span className="ml-auto tnum" style={{ color: 'var(--text-h)' }}>
              {fmtPct(r.value / denom)}
            </span>
          </div>
        ))}
      </div>
      {hover && wrapperRef.current && (
        <ChartTooltip
          label={rows[hover.idx].label}
          value={rows[hover.idx].value}
          pct={rows[hover.idx].value / denom}
          swatchColor={colors[hover.idx] ?? colors[colors.length - 1]}
          x={hover.x}
          y={hover.y}
          containerWidth={wrapperRef.current.getBoundingClientRect().width}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card builders — aggregate vs per-zip use the same shapes.
// ---------------------------------------------------------------------------
function CardsForRacWac({
  scope,
  wacLatest,
  wacTrend,
  racLatest,
  racTrend,
  mode,
  trendDomain,
  showWacTotal = true,
  isAggregate = false,
  segmentFilter,
  odMixOverride,
}: {
  scope: string;
  wacLatest: RacWacLatest | null;
  wacTrend: RacWacTrend | null;
  // RAC counterparts. In a per-anchor view the Workforce mix card switches
  // its data source by direction: inbound mode reads WAC (workers AT this
  // anchor), outbound mode reads RAC (residents OF this anchor commuting
  // out). Aggregate view keeps the original WAC charts for both modes.
  racLatest: RacWacLatest | null;
  racTrend: RacWacTrend | null;
  mode: Mode;
  trendDomain?: [number, number];
  // When false, the standalone "Total jobs (WAC)" sparkline card is hidden.
  // The OD card already exposes a totalJobs trend in the per-anchor view, so
  // the WAC total tile would be redundant there.
  showWacTotal?: boolean;
  // When true (aggregate mode — no ZIP selected), the workforce-mix card is
  // split into three chart cards (vertical-bar Age, horizontal-bar Wages,
  // pie Industry). Per-anchor view keeps the original three-section
  // breakdown table.
  isAggregate?: boolean;
  // Active LODES segment filter — when axis matches age/wage/naics3, the
  // WAC Total jobs card collapses to the filtered headline + sparkline.
  // The breakdown cards (age/wage/industry/race/etc.) keep their full-totals
  // visual treatment per spec.
  segmentFilter: SegmentFilter;
  // OD-derived workforce mix override for per-anchor view. When present, the
  // Workforce mix card is built from per-pair LODES OD segment cells summed
  // across the anchor's mode-active flows (and narrowed to selectedPartner
  // when set), rather than from the anchor's RAC/WAC totals. The OD source
  // tracks partner selection naturally — useful for "show me the demographic
  // mix of just Rifle commuters" without leaving the strip.
  //
  // LODES caveat: per-pair age/wage/industry cells are uni-axis. When a
  // segment-filter axis is active, this override still presents all three
  // axes; only the workerCount headline narrows to the filtered axis. Joint
  // cross-axis cells aren't published by LODES, so the off-axis breakdowns
  // remain the unfiltered population by construction. This matches RAC/WAC
  // behavior under the filter.
  odMixOverride?: {
    age: AgeBlock;
    wage: WageBlock;
    naics3: Naics3Block;
    total: number;
    title: string;
    subtitle: string;
  } | null;
}) {
  const filterActive = !isSegmentFilterAll(segmentFilter);
  const filteredWacTotalLatest =
    filterActive && wacLatest
      ? filteredOdLatestTotal(wacLatest, segmentFilter)
      : wacLatest?.totalJobs ?? 0;
  const filteredWacTotalTrend =
    filterActive && wacTrend
      ? filteredTrendSeries(wacTrend, segmentFilter)
      : wacTrend?.totalJobs ?? [];

  // Per-anchor mode-aware data source for the Workforce mix card.
  // Priority: OD-derived override (when provided) > RAC (outbound) > WAC.
  // The OD path makes the card respond to selectedPartner and mode without
  // a parallel RAC/WAC plumbing pass.
  const useOdOverride = !isAggregate && odMixOverride != null;
  const mixIsRac = !useOdOverride && !isAggregate && mode === 'outbound' && racLatest != null;
  const mixBlock: { age: AgeBlock; wage: WageBlock; naics3: Naics3Block } | null = useOdOverride
    ? odMixOverride!
    : mixIsRac
      ? racLatest!
      : wacLatest;
  const mixSourceLabel = useOdOverride
    ? odMixOverride!.subtitle
    : mixIsRac
      ? 'RAC · latest year'
      : 'WAC · latest year';
  const mixTitle = useOdOverride
    ? odMixOverride!.title
    : `${scope} · Workforce mix`;
  const mixTotalKey = useOdOverride
    ? odMixOverride!.total
    : mixIsRac
      ? racLatest?.totalJobs ?? 0
      : wacLatest?.totalJobs ?? 0;

  return (
    <>
      {showWacTotal && wacLatest && wacTrend && (
        <Card
          title={`${scope} · Total jobs (WAC)`}
          subtitle="Workplace total jobs · 2002–2023"
        >
          <HeadlineNumber value={filteredWacTotalLatest} />
          <div className="flex-1 min-h-0">
            <Sparkline
              series={filteredWacTotalTrend}
              yDomain={trendDomain}
              dotColor="var(--text-h)"
              name="Total jobs"
              fill
            />
          </div>
        </Card>
      )}
      {wacLatest && isAggregate && (
        <>
          <Card title={`${scope} · Age`} subtitle="WAC · latest year" width={220}>
            <AgeBarChart rows={ageRows(wacLatest.age)} total={wacLatest.totalJobs} />
          </Card>
          <Card title={`${scope} · Wages`} subtitle="WAC · latest year" width={240}>
            <WageBarChart rows={wageRows(wacLatest.wage)} total={wacLatest.totalJobs} />
          </Card>
          <Card title={`${scope} · Industry · NAICS-3`} subtitle="WAC · latest year" width={240}>
            <NaicsPieChart rows={naicsRows(wacLatest.naics3)} total={wacLatest.totalJobs} />
          </Card>
        </>
      )}
      {mixBlock && !isAggregate && (
        <Card title={mixTitle} subtitle={mixSourceLabel} width={280}>
          <BreakdownSection label="Age">
            <Breakdown rows={ageRows(mixBlock.age)} total={mixTotalKey} />
          </BreakdownSection>
          <BreakdownSection label="Wages">
            <Breakdown rows={wageRows(mixBlock.wage)} total={mixTotalKey} />
          </BreakdownSection>
          <BreakdownSection label="Industry · NAICS-3">
            <Breakdown rows={naicsRows(mixBlock.naics3)} total={mixTotalKey} />
          </BreakdownSection>
        </Card>
      )}
    </>
  );
}

// Headline row used inside the merged OD card — small swatch + label + value.
// The shared sparkline renders below the stacked headlines so the two flow
// series can be visually compared on identical axes.
function FlowHeadline({
  label,
  value,
  swatchColor,
}: {
  label: string;
  value: number;
  swatchColor: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: swatchColor }}
        />
        <div
          className="text-[9px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          {label}
        </div>
      </div>
      <HeadlineNumber value={value} />
    </div>
  );
}

// Multi-series sparkline — renders N lines + gradient areas + latest-value
// dots in a single SVG sharing one x and one y axis. Used by the merged
// "Workforce flows (OD)" card so inflow and outflow are visually comparable.
function MultiSparkline({
  series,
  yDomain,
  fill = false,
}: {
  series: { name: string; points: TrendPoint[]; color: string; dotColor: string }[];
  yDomain?: [number, number];
  // When true, the SVG fills its parent vertically (100% height) instead
  // of rendering at a fixed pixel height. The viewBox + preserveAspectRatio
  // "none" lets the chart stretch into whatever space the parent allocates.
  fill?: boolean;
}) {
  const gradId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const yearsAndScales = useMemo(() => {
    const flat = series.flatMap((s) => s.points);
    if (flat.length < 2) return null;
    const ys = flat.map((p) => p.value);
    const xs = flat.map((p) => p.year);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = yDomain ? yDomain[0] : Math.min(...ys);
    const yMax = yDomain ? yDomain[1] : Math.max(...ys);
    const xSpan = xMax - xMin || 1;
    const ySpan = yMax - yMin || 1;
    const sx = (x: number) => ((x - xMin) / xSpan) * (SPARK_VB_W - 4) + 2;
    const sy = (y: number) =>
      LINE_BAND_H - 4 - ((y - yMin) / ySpan) * (LINE_BAND_H - 8);
    return { sx, sy };
  }, [series, yDomain]);

  const geometry = useMemo(() => {
    if (!yearsAndScales) return null;
    const { sx, sy } = yearsAndScales;
    const lineGen = d3Line<TrendPoint>().x((d) => sx(d.year)).y((d) => sy(d.value));
    const areaGen = d3Area<TrendPoint>()
      .x((d) => sx(d.year))
      .y0(SPARK_VB_H)
      .y1((d) => sy(d.value));
    return series.map((s) => {
      const last = s.points[s.points.length - 1];
      return {
        linePath: lineGen(s.points) ?? '',
        areaPath: areaGen(s.points) ?? '',
        lastX: sx(last.year),
        lastY: sy(last.value),
        color: s.color,
        dotColor: s.dotColor,
      };
    });
  }, [series, yearsAndScales]);

  const years = useMemo(() => unionYears(series.map((s) => s.points)), [series]);
  const hoverHandlers = useMemo(
    () => makeHoverHandlers(wrapperRef, years, setHover),
    [years],
  );

  if (!geometry || !yearsAndScales) return null;
  const { sx, sy } = yearsAndScales;

  // Resolve each series's value at the hovered year (snap to the nearest
  // point if a series doesn't carry that exact year — sparse trends, etc.).
  const hoveredYear =
    hover && years.length > 0 ? years[Math.min(hover.yearIdx, years.length - 1)] : null;
  const hoveredValues =
    hoveredYear == null
      ? null
      : series.map((s) => {
          let nearest = s.points[0];
          let bestD = Infinity;
          for (const p of s.points) {
            const d = Math.abs(p.year - hoveredYear);
            if (d < bestD) {
              bestD = d;
              nearest = p;
            }
          }
          return { name: s.name, year: nearest.year, value: nearest.value, color: s.dotColor };
        });

  // Same trick as the single-series Sparkline — render dots as overlay HTML
  // so they stay perfect circles under the SVG's non-uniform horizontal
  // stretch.
  return (
    <div
      ref={wrapperRef}
      className="relative w-full"
      style={{ height: fill ? '100%' : SPARK_VB_H }}
      onMouseMove={hoverHandlers.onMove}
      onMouseLeave={hoverHandlers.onLeave}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SPARK_VB_W} ${SPARK_VB_H}`}
        preserveAspectRatio="none"
        role="img"
        style={{ display: 'block' }}
      >
        <defs>
          {geometry.map((g, i) => (
            <linearGradient
              key={`g-${i}`}
              id={`${gradId}-${i}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={g.color} stopOpacity="0.32" />
              <stop offset="100%" stopColor={g.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {geometry.map((g, i) => (
          <path
            key={`a-${i}`}
            d={g.areaPath}
            fill={`url(#${gradId}-${i})`}
            stroke="none"
          />
        ))}
        {geometry.map((g, i) => (
          <path
            key={`l-${i}`}
            d={g.linePath}
            fill="none"
            stroke={g.color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hoveredYear != null && (
          <line
            x1={sx(hoveredYear)}
            x2={sx(hoveredYear)}
            y1={0}
            y2={SPARK_VB_H}
            stroke="var(--text-dim)"
            strokeWidth={1}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
            opacity={0.6}
          />
        )}
      </svg>
      {geometry.map((g, i) => (
        <span
          key={`d-${i}`}
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            left: `${(g.lastX / SPARK_VB_W) * 100}%`,
            top: `${(g.lastY / SPARK_VB_H) * 100}%`,
            width: 6,
            height: 6,
            background: g.dotColor,
            transform: 'translate(-50%, -50%)',
          }}
        />
      ))}
      {hoveredValues?.map((v, i) => (
        <span
          key={`hd-${i}`}
          aria-hidden
          className="absolute rounded-full pointer-events-none"
          style={{
            left: `${(sx(v.year) / SPARK_VB_W) * 100}%`,
            top: `${(sy(v.value) / SPARK_VB_H) * 100}%`,
            width: 6,
            height: 6,
            background: v.color,
            border: '1px solid var(--text-h)',
            transform: 'translate(-50%, -50%)',
          }}
        />
      ))}
      {hover && hoveredYear != null && hoveredValues && wrapperRef.current && (
        <HoverTooltip
          year={hoveredYear}
          rows={hoveredValues}
          x={hover.clientX}
          containerWidth={wrapperRef.current.getBoundingClientRect().width}
        />
      )}
    </div>
  );
}

// Third-series color for "Resident workers" — neutral slate so it reads
// as supplementary against the amber (inflow) / white (outflow) pair.
const RESIDENT_COLOR = '#9ca3af';

function CardsForOd({
  scope,
  inflowLatest,
  inflowTrend,
  outflowLatest,
  outflowTrend,
  withinLatest,
  withinTrend,
  trendDomain,
}: {
  scope: string;
  inflowLatest: { totalJobs: number } | null;
  inflowTrend: TrendPoint[];
  outflowLatest: { totalJobs: number } | null;
  outflowTrend: TrendPoint[];
  // Within-ZIP commuters (h_zip == w_zip) — people who live AND work in
  // this ZIP. Computed from OD self-pairs upstream, kept separate from
  // inflow/outflow which are strictly cross-ZIP.
  withinLatest: { totalJobs: number } | null;
  withinTrend: TrendPoint[];
  trendDomain?: [number, number];
}) {
  if (!inflowLatest && !outflowLatest && !withinLatest) return null;
  const sparkSeries: {
    name: string;
    points: TrendPoint[];
    color: string;
    dotColor: string;
  }[] = [];
  if (inflowLatest && inflowTrend.length > 1) {
    sparkSeries.push({
      name: 'Inflow',
      points: inflowTrend,
      color: 'var(--accent)',
      dotColor: 'var(--accent)',
    });
  }
  if (outflowLatest && outflowTrend.length > 1) {
    sparkSeries.push({
      name: 'Outflow',
      points: outflowTrend,
      color: 'var(--text-h)',
      dotColor: 'var(--text-h)',
    });
  }
  if (withinLatest && withinTrend.length > 1) {
    sparkSeries.push({
      name: 'Residents',
      points: withinTrend,
      color: RESIDENT_COLOR,
      dotColor: RESIDENT_COLOR,
    });
  }
  return (
    <Card
      title={`${scope} · Workforce flows (OD)`}
      subtitle="Commuters · live-and-work · 2002–2023"
      width={260}
    >
      <div className="flex gap-3">
        {inflowLatest && (
          <FlowHeadline
            label="Inflow"
            value={inflowLatest.totalJobs}
            swatchColor="var(--accent)"
          />
        )}
        {outflowLatest && (
          <FlowHeadline
            label="Outflow"
            value={outflowLatest.totalJobs}
            swatchColor="var(--text-h)"
          />
        )}
        {withinLatest && (
          <FlowHeadline
            label="Residents"
            value={withinLatest.totalJobs}
            swatchColor={RESIDENT_COLOR}
          />
        )}
      </div>
      {sparkSeries.length > 0 && (
        <div className="flex-1 min-h-0">
          <MultiSparkline series={sparkSeries} yDomain={trendDomain} fill />
        </div>
      )}
    </Card>
  );
}

// `denominator` is the ZIP's full workforce universe (WAC totalJobs for the
// inflow list, RAC totalJobs for the outflow list) so per-row shares match
// the left-panel "Top 10" denominator. Falls back to the partner sum when no
// denominator is supplied.
//
// `withinZip` (optional) injects a within-ZIP commute row immediately above
// the pinned "All Other Locations" residual, mirroring the left-panel layout.
function PartnerList({
  partners,
  denominator,
  withinZip,
}: {
  partners: OdPartner[];
  denominator?: number;
  withinZip?: { zip: string; workers: number };
}) {
  if (partners.length === 0) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
        No partner ZIPs in latest vintage.
      </div>
    );
  }
  const total =
    denominator && denominator > 0
      ? denominator
      : partners.reduce((s, p) => s + p.workers, 0) || 1;
  // Split named partners from the ALL_OTHER residual so the within-ZIP row
  // can be inserted between them.
  const namedPartners = partners.filter((p) => p.zip !== 'ALL_OTHER');
  const allOther = partners.find((p) => p.zip === 'ALL_OTHER');
  return (
    <table className="w-full text-[11px] tnum">
      <tbody>
        {namedPartners.map((p) => (
          <tr key={`${p.place}|${p.zip}`}>
            <td className="pr-2 truncate" style={{ color: 'var(--text-h)' }}>
              {p.place || p.zip}
              <span className="ml-1" style={{ color: 'var(--text-dim)' }}>
                · {p.zip}
              </span>
            </td>
            <td className="text-right pr-2" style={{ color: 'var(--text-h)' }}>
              {fmtInt(p.workers)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(p.workers / total)}
            </td>
          </tr>
        ))}
        {withinZip && withinZip.workers > 0 && (
          <tr>
            <td className="pr-2 truncate" style={{ color: 'var(--text-h)' }}>
              Within-ZIP commute
            </td>
            <td className="text-right pr-2" style={{ color: 'var(--text-h)' }}>
              {fmtInt(withinZip.workers)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(withinZip.workers / total)}
            </td>
          </tr>
        )}
        {allOther && (
          <tr>
            <td className="pr-2 truncate" style={{ color: 'var(--text-h)' }}>
              {allOther.place || 'All Other Locations'}
            </td>
            <td className="text-right pr-2" style={{ color: 'var(--text-h)' }}>
              {fmtInt(allOther.workers)}
            </td>
            <td className="text-right" style={{ color: 'var(--text-dim)' }}>
              {fmtPct(allOther.workers / total)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Workplace / Residence Metrics (per-anchor only)
// ---------------------------------------------------------------------------
// Surfaces five anchor facts at a glance, with semantics flipped by the
// active map mode:
//   • Total Workers / Total Resident Workers
//       inbound  → WAC totalJobs (workforce universe = inflow + within)
//       outbound → RAC totalJobs (resident-worker universe = outflow + within)
//   • Cross-ZIP commute share / Cross-ZIP outbound share
//       inbound  → inflow / (inflow + within)
//       outbound → outflow / (outflow + within)
//   • Avg. commute distance      — worker-weighted miles across the active
//                                  mode's cross-ZIP flows (drive-distance
//                                  preferred, Haversine × detour fallback)
//   • Top corridor               — corridor carrying the most workers in the
//                                  active mode through the selected anchor
//   • Top O–D pair               — single highest origin → anchor (inbound)
//                                  or anchor → destination (outbound) flow
function MetricRow({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="text-[9px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        {label}
      </div>
      <div
        className="text-[13px] font-semibold tnum leading-tight"
        style={{ color: 'var(--text-h)' }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function WorkplaceMetricsCard({
  scope,
  selectedZip,
  selectedPartner,
  mode,
  wacLatest,
  racLatest,
  inflowLatest,
  outflowLatest,
  withinLatest,
  topInflowPartner,
  topOutflowPartner,
  flowsInbound,
  flowsOutbound,
  zips,
  corridorIndex,
  flowIndex,
  driveDistance,
  segmentFilter,
}: {
  scope: string;
  selectedZip: string;
  // When set, the three partner-scoped metrics (Total Workers, Cross-ZIP
  // commute share, Average commute distance) recompute against the single
  // partner↔anchor flow. Top corridor and Top O–D pair stay anchor-scoped
  // per spec — the user's request named only those three for filtering.
  selectedPartner: { place: string; zips: string[] } | null;
  // Map mode controls whether this card frames stats around workplace
  // (inbound — workers commuting in) or residence (outbound — residents
  // commuting out). All five metrics flip semantics; partner-scoped
  // overrides follow the same direction.
  mode: Mode;
  wacLatest: RacWacLatest | null;
  racLatest: RacWacLatest | null;
  inflowLatest: { totalJobs: number } | null;
  outflowLatest: { totalJobs: number } | null;
  withinLatest: { totalJobs: number } | null;
  topInflowPartner: OdPartner | null;
  topOutflowPartner: OdPartner | null;
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  zips: ZipMeta[];
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  driveDistance: DriveDistanceMap | null;
  segmentFilter: SegmentFilter;
}) {
  const isInbound = mode === 'inbound';

  // Anchor-touching flows for the active mode. Inbound: dest = anchor;
  // outbound: origin = anchor. Self-flows and ALL_OTHER are kept here; the
  // consumers (meanCommuteMiles, corridor builder) handle exclusion.
  const anchorFlows = useMemo(() => {
    const dataset = isInbound ? flowsInbound : flowsOutbound;
    return dataset.filter((f) =>
      isInbound ? f.destZip === selectedZip : f.originZip === selectedZip,
    );
  }, [isInbound, flowsInbound, flowsOutbound, selectedZip]);

  // Partner-scoped subset — single partner→anchor (inbound) or
  // anchor→partner (outbound) flow(s). Multi-ZIP cities sum across all of
  // their ZIPs so the headline matches the row clicked in StatsForZip.
  const partnerFlows = useMemo(() => {
    if (!selectedPartner) return [];
    const set = new Set(selectedPartner.zips);
    return anchorFlows.filter((f) =>
      isInbound ? set.has(f.originZip) : set.has(f.destZip),
    );
  }, [anchorFlows, selectedPartner, isInbound]);

  // Anchor-wide weighted mean (always computed for the unfiltered display).
  const anchorAvgMiles = useMemo(
    () => meanCommuteMiles(anchorFlows, zips, driveDistance ?? undefined),
    [anchorFlows, zips, driveDistance],
  );

  // Partner-scoped weighted mean — single OD pair (or a small set of pairs
  // for multi-ZIP cities); meanCommuteMiles already excludes self / ALL_OTHER.
  const partnerAvgMiles = useMemo(
    () => meanCommuteMiles(partnerFlows, zips, driveDistance ?? undefined),
    [partnerFlows, zips, driveDistance],
  );

  // Highest-volume corridor among flows touching this anchor (in active
  // mode). Self-flows have no corridorPath, so they drop out naturally.
  // Stays anchor-scoped regardless of partner — partner filter applies only
  // to the three named metrics per the user spec.
  const topCorridor = useMemo<{ label: string; total: number } | null>(() => {
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, anchorFlows, mode);
    if (map.size === 0) return null;
    let best: ActiveCorridorAggregation | null = null;
    for (const agg of map.values()) {
      if (!best || agg.total > best.total) best = agg;
    }
    return best ? { label: best.corridor.label, total: best.total } : null;
  }, [corridorIndex, flowIndex, anchorFlows, mode]);

  // Anchor-wide totals (workforce / resident-worker universe). Under the
  // segment filter we re-aggregate WAC (inbound) or RAC (outbound) against
  // the active axis buckets so the headline matches the filtered population.
  // When the source block is missing we fall back to the directional flow +
  // within, both of which already carry filtered totals from perZipBlocks.
  const directionalLatest = isInbound ? wacLatest : racLatest;
  const directionalFlow = isInbound
    ? inflowLatest?.totalJobs ?? 0
    : outflowLatest?.totalJobs ?? 0;
  const anchorWithin = withinLatest?.totalJobs ?? 0;
  const anchorTotalWorkers = directionalLatest
    ? filteredLatestTotal(directionalLatest, segmentFilter)
    : directionalFlow + anchorWithin;
  const anchorCrossDenom = directionalFlow + anchorWithin;
  const anchorCrossShare =
    anchorCrossDenom > 0 ? directionalFlow / anchorCrossDenom : 0;

  // Partner-scoped totals. Workers count comes from the live FlowRow set
  // (latest LEHD vintage), keeping it consistent with the Top-10 list value.
  const partnerWorkers = partnerFlows.reduce((s, f) => s + f.workerCount, 0);
  // Partner contribution to the anchor's cross-ZIP universe — i.e., what
  // share of the cross-ZIP commuters (or resident commuters out) this
  // partner accounts for.
  const partnerCrossShare =
    directionalFlow > 0 ? partnerWorkers / directionalFlow : 0;

  const isPartnerScoped = selectedPartner != null;
  const topPartner = isInbound ? topInflowPartner : topOutflowPartner;

  // Mode-dependent labels. Inbound frames the anchor as a workplace; outbound
  // frames it as a residence. The partner sits on the origin side in inbound
  // mode and the destination side in outbound mode — the O–D arrow flips.
  const cardTitle = isInbound
    ? `${scope} · Workplace Metrics`
    : `${scope} · Residence Metrics`;
  const totalLabel = isInbound ? 'Total Workers' : 'Total Resident Workers';
  const totalShareLabel = isInbound ? 'workforce' : 'resident workers';
  const crossShareLabel = isInbound
    ? 'Cross-ZIP commute share'
    : 'Cross-ZIP outbound share';
  const crossShareSubAnchor = isInbound
    ? `${fmtInt(directionalFlow)} of ${fmtInt(anchorCrossDenom)} workers commute in`
    : `${fmtInt(directionalFlow)} of ${fmtInt(anchorCrossDenom)} residents commute out`;
  const crossShareSubPartner = isInbound
    ? `${fmtInt(partnerWorkers)} of ${fmtInt(directionalFlow)} cross-ZIP commuters`
    : `${fmtInt(partnerWorkers)} of ${fmtInt(directionalFlow)} cross-ZIP outbound residents`;
  const distanceSub = isInbound
    ? 'Worker-weighted · inbound cross-ZIP'
    : 'Worker-weighted · outbound cross-ZIP';
  const distanceSubPartner = isInbound
    ? `From ${selectedPartner?.place ?? ''} · worker-weighted`
    : `To ${selectedPartner?.place ?? ''} · worker-weighted`;
  const topPartnerArrow = topPartner
    ? isInbound
      ? `${topPartner.place || topPartner.zip} → ${scope}`
      : `${scope} → ${topPartner.place || topPartner.zip}`
    : '—';

  return (
    <Card
      title={cardTitle}
      subtitle={
        isPartnerScoped
          ? isInbound
            ? `Filtered: from ${selectedPartner!.place} · latest year`
            : `Filtered: to ${selectedPartner!.place} · latest year`
          : 'At-a-glance · latest year'
      }
      width={280}
    >
      <MetricRow
        label={totalLabel}
        value={fmtInt(isPartnerScoped ? partnerWorkers : anchorTotalWorkers)}
        sub={
          isPartnerScoped
            ? `${fmtPct(partnerWorkers / Math.max(1, anchorTotalWorkers))} of ${scope} ${totalShareLabel}`
            : undefined
        }
      />
      <MetricRow
        label={crossShareLabel}
        value={fmtPct(isPartnerScoped ? partnerCrossShare : anchorCrossShare)}
        sub={isPartnerScoped ? crossShareSubPartner : crossShareSubAnchor}
      />
      <MetricRow
        label="Average commute distance"
        value={
          (isPartnerScoped ? partnerAvgMiles : anchorAvgMiles) > 0
            ? `${(isPartnerScoped ? partnerAvgMiles : anchorAvgMiles).toFixed(1)} mi`
            : '—'
        }
        sub={isPartnerScoped ? distanceSubPartner : distanceSub}
      />
      <MetricRow
        label="Top corridor"
        value={topCorridor?.label ?? '—'}
        sub={topCorridor ? `${fmtInt(topCorridor.total)} workers` : undefined}
      />
      <MetricRow
        label="Top O–D pair"
        value={topPartnerArrow}
        sub={topPartner ? `${fmtInt(topPartner.workers)} workers` : undefined}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Top-level switch
// ---------------------------------------------------------------------------
interface Props {
  racFile: RacFile;
  wacFile: WacFile;
  odSummary: OdSummaryFile;
  selectedZip: string | null;
  // Optional secondary partner selection — when set, the OD flows card and
  // the Workplace Metrics card narrow their scope from the anchor's full
  // workforce universe to the single partner→anchor (inbound mode) or
  // anchor→partner (outbound mode) flow.
  selectedPartner: { place: string; zips: string[] } | null;
  mode: Mode;
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  zips: ZipMeta[];
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  driveDistance: DriveDistanceMap | null;
  // Active LODES segment filter — slices OD inflow/outflow/within-zip cards
  // and the OD-axis dimensions on RAC/WAC. Education / race / ethnicity /
  // sex stay anchored to full totals — LODES has no OD analogue for those
  // dimensions, so the filter doesn't touch their cards.
  segmentFilter: SegmentFilter;
  onSegmentFilterChange: (next: SegmentFilter) => void;
}

function findEntry<T extends { zip: string }>(entries: T[], zip: string): T | null {
  return entries.find((e) => e.zip === zip) ?? null;
}

// Re-derive Top Partner worker counts from the active-filter FlowRow arrays
// arriving at BottomCardStrip. App.tsx runs `applySegmentFilter` upstream so
// the workerCount on each row already carries the sum of selected buckets
// within the active axis. Summing per partner here is therefore filter-aware
// for free.
//
// Inflow side: partner sits on the origin (workers commuting INTO anchor).
// Outflow side: partner sits on the destination (residents commuting OUT).
//
// ALL_OTHER residual: the inbound dataset literally carries an 'ALL_OTHER'
// origin row (mapped back to "outside the study area"); the outbound dataset
// does not — it lists every cross-state destination explicitly. So the
// residual is computed as either-or: any literal ALL_OTHER endpoint plus any
// cross-ZIP flow whose partner-side ZIP is not in the union of named partner
// ZIPs. This matches how od-summary.json builds the residual at build time.
//
// Returns a new array sorted desc by filtered workers, with zero-worker
// named partners dropped. The ALL_OTHER residual is preserved (pinned last)
// so the table layout matches the unfiltered case.
function filterPartners(
  partners: OdPartner[],
  flows: FlowRow[],
  anchorZip: string,
  side: 'inflow' | 'outflow',
): OdPartner[] {
  const namedZipSet = new Set<string>();
  for (const p of partners) {
    if (p.zip === 'ALL_OTHER') continue;
    for (const z of p.zips) namedZipSet.add(z);
  }

  const workersByZip = new Map<string, number>();
  let allOtherWorkers = 0;
  for (const f of flows) {
    if (side === 'inflow') {
      if (f.destZip !== anchorZip) continue;
      if (f.originZip === f.destZip) continue; // within-ZIP, surfaced separately
      if (f.originZip === 'ALL_OTHER' || !namedZipSet.has(f.originZip)) {
        allOtherWorkers += f.workerCount;
      } else {
        workersByZip.set(
          f.originZip,
          (workersByZip.get(f.originZip) ?? 0) + f.workerCount,
        );
      }
    } else {
      if (f.originZip !== anchorZip) continue;
      if (f.originZip === f.destZip) continue;
      if (f.destZip === 'ALL_OTHER' || !namedZipSet.has(f.destZip)) {
        allOtherWorkers += f.workerCount;
      } else {
        workersByZip.set(
          f.destZip,
          (workersByZip.get(f.destZip) ?? 0) + f.workerCount,
        );
      }
    }
  }

  const named: OdPartner[] = [];
  let allOther: OdPartner | null = null;
  for (const p of partners) {
    if (p.zip === 'ALL_OTHER') {
      allOther = { ...p, workers: allOtherWorkers };
      continue;
    }
    let sum = 0;
    for (const z of p.zips) sum += workersByZip.get(z) ?? 0;
    if (sum > 0) named.push({ ...p, workers: sum });
  }
  named.sort((a, b) => b.workers - a.workers);
  return allOther ? [...named, allOther] : named;
}

function aggregateScope(): string {
  return 'Region';
}

// Per-block resolver: applies the segment filter to OD inflow/outflow/within
// latest+trend. When the filter is inactive, returns the full-totalJobs
// values exactly as before. When active, the headline integers come from
// filteredOdLatestTotal (sum of selected buckets in the latest block) and
// the sparkline series come from filteredTrendSeries (per-year sum across
// selected bucket dims). RAC/WAC `latest`/`trend` pass through untouched —
// CardsForRacWac handles its own per-axis filter recomputation below.
function aggregateBlocks(
  rac: RacWacAggregate,
  wac: RacWacAggregate,
  od: OdAggregate,
  segmentFilter: SegmentFilter,
) {
  return {
    racLatest: rac.latest,
    racTrend: rac.trend,
    wacLatest: wac.latest,
    wacTrend: wac.trend,
    // The OD dataset is a ring of pairs touching the 11 anchors (not a closed
    // universe), so inflow and outflow are NOT symmetric at the regional level
    // — emit them separately, matching the per-zip view.
    inflowLatest: od.inflow.latest
      ? { totalJobs: filteredOdLatestTotal(od.inflow.latest, segmentFilter) }
      : null,
    inflowTrend: filteredTrendSeries(od.inflow.trend, segmentFilter),
    outflowLatest: od.outflow.latest
      ? { totalJobs: filteredOdLatestTotal(od.outflow.latest, segmentFilter) }
      : null,
    outflowTrend: filteredTrendSeries(od.outflow.trend, segmentFilter),
    withinLatest: od.withinZip.latest
      ? { totalJobs: filteredOdLatestTotal(od.withinZip.latest, segmentFilter) }
      : null,
    withinTrend: filteredTrendSeries(od.withinZip.trend, segmentFilter),
  };
}

function perZipBlocks(
  racEntry: RacFile['entries'][number] | null,
  wacEntry: WacFile['entries'][number] | null,
  odEntry: OdSummaryEntry | null,
  segmentFilter: SegmentFilter,
) {
  return {
    racLatest: racEntry?.latest ?? null,
    racTrend: racEntry?.trend ?? null,
    wacLatest: wacEntry?.latest ?? null,
    wacTrend: wacEntry?.trend ?? null,
    inflowLatest: odEntry?.inflow.latest
      ? { totalJobs: filteredOdLatestTotal(odEntry.inflow.latest, segmentFilter) }
      : null,
    inflowTrend: filteredTrendSeries(odEntry?.inflow.trend ?? null, segmentFilter),
    outflowLatest: odEntry?.outflow.latest
      ? { totalJobs: filteredOdLatestTotal(odEntry.outflow.latest, segmentFilter) }
      : null,
    outflowTrend: filteredTrendSeries(odEntry?.outflow.trend ?? null, segmentFilter),
    withinLatest: odEntry?.withinZip.latest
      ? { totalJobs: filteredOdLatestTotal(odEntry.withinZip.latest, segmentFilter) }
      : null,
    withinTrend: filteredTrendSeries(odEntry?.withinZip.trend ?? null, segmentFilter),
  };
}

export function BottomCardStrip({
  racFile,
  wacFile,
  odSummary,
  selectedZip,
  selectedPartner,
  mode,
  flowsInbound,
  flowsOutbound,
  zips,
  corridorIndex,
  flowIndex,
  driveDistance,
  segmentFilter,
  onSegmentFilterChange,
}: Props) {
  const isPerZip = selectedZip != null && selectedZip !== 'ALL_OTHER';

  // Partner-scoped flow value used to override the OD card's inflow/outflow
  // headlines when a partner is selected. Source dataset is mode-aware:
  //   inbound  → partner sits on the origin side (commuters in)
  //   outbound → partner sits on the destination side (commuters out)
  const partnerFlowWorkers = useMemo(() => {
    if (!isPerZip || !selectedPartner) return 0;
    const set = new Set(selectedPartner.zips);
    const dataset = mode === 'inbound' ? flowsInbound : flowsOutbound;
    let total = 0;
    for (const f of dataset) {
      if (mode === 'inbound') {
        if (f.destZip !== selectedZip) continue;
        if (!set.has(f.originZip)) continue;
      } else {
        if (f.originZip !== selectedZip) continue;
        if (!set.has(f.destZip)) continue;
      }
      total += f.workerCount;
    }
    return total;
  }, [isPerZip, selectedPartner, selectedZip, mode, flowsInbound, flowsOutbound]);

  // Match the selected partner against the per-anchor topPartners list to
  // pick up the year-by-year trend baked into od-summary.json. Match key is
  // the ZIP set (sorted), which uniquely identifies the row regardless of
  // place name capitalization quirks. The mode picks which side of the OD
  // pair the partner sits on.
  const odEntryForPartner = useMemo(
    () => (isPerZip ? findEntry(odSummary.entries, selectedZip) : null),
    [isPerZip, odSummary, selectedZip],
  );
  const partnerTrend = useMemo<TrendPoint[]>(() => {
    if (!selectedPartner || !odEntryForPartner) return [];
    const want = [...selectedPartner.zips].sort().join('|');
    const list =
      mode === 'inbound'
        ? odEntryForPartner.topPartners.inflow
        : odEntryForPartner.topPartners.outflow;
    const match = list.find((p) => [...(p.zips ?? [])].sort().join('|') === want);
    return match?.trend ?? [];
  }, [selectedPartner, odEntryForPartner, mode]);

  const racEntry = isPerZip ? findEntry(racFile.entries, selectedZip) : null;
  const wacEntry = isPerZip ? findEntry(wacFile.entries, selectedZip) : null;
  const odEntry = isPerZip ? findEntry(odSummary.entries, selectedZip) : null;
  const filterActive = !isSegmentFilterAll(segmentFilter);

  const blocks = isPerZip
    ? perZipBlocks(racEntry, wacEntry, odEntry, segmentFilter)
    : aggregateBlocks(
        racFile.aggregate,
        wacFile.aggregate,
        odSummary.aggregate,
        segmentFilter,
      );

  const scope = isPerZip
    ? `${odEntry?.place || racEntry?.place || wacEntry?.place || selectedZip}`
    : aggregateScope();

  // Y-domains for the trend cards. Both are zero-based so visual height is
  // proportional to the actual values (no compressed-range exaggeration).
  // The OD domain spans only inflow/outflow/within so the three lines spread
  // out to the full canvas height; WAC is excluded because it lives in its
  // own card and would otherwise inflate the OD scale.
  const odDomain = useMemo<[number, number] | undefined>(() => {
    // When a partner is selected, the OD card collapses to a single
    // partner-scoped sparkline. Scale to its own range so the line uses
    // the full canvas height instead of compressing against the much
    // larger anchor-wide totals.
    if (selectedPartner && partnerTrend.length > 0) {
      const vals = partnerTrend.map((p) => p.value);
      return [0, Math.max(...vals)];
    }
    const all: number[] = [];
    blocks.inflowTrend.forEach((p) => all.push(p.value));
    blocks.outflowTrend.forEach((p) => all.push(p.value));
    blocks.withinTrend.forEach((p) => all.push(p.value));
    if (all.length === 0) return undefined;
    return [0, Math.max(...all)];
  }, [
    selectedPartner,
    partnerTrend,
    blocks.inflowTrend,
    blocks.outflowTrend,
    blocks.withinTrend,
  ]);
  const wacDomain = useMemo<[number, number] | undefined>(() => {
    const vals = blocks.wacTrend?.totalJobs.map((p) => p.value) ?? [];
    if (vals.length === 0) return undefined;
    return [0, Math.max(...vals)];
  }, [blocks.wacTrend]);

  // OD-derived workforce mix for the per-anchor view.
  // ----------------------------------------------------------------------
  // Sums each FlowRow's `segments` block across the anchor's mode-active
  // flow set, optionally narrowed to the selected partner. The result mirrors
  // the shape RAC/WAC blocks expose (age/wage/naics3 + total) so
  // CardsForRacWac can swap data sources behind one prop.
  //
  // Why this exists: RAC/WAC are anchor-level rollups — they don't move when
  // a partner row is clicked. Switching the mix card to per-pair OD segments
  // lets the breakdown narrow to "the demographic mix of just Rifle → GWS"
  // (or any selected partner) using the same cells already on each FlowRow.
  //
  // Mode mapping:
  //   inbound  → flows where destZip === anchor (workplace universe).
  //              Self-flows (within-ZIP commute) are KEPT — those workers
  //              both live and work in the anchor and belong in its
  //              workforce.
  //   outbound → flows where originZip === anchor AND destZip !== anchor
  //              (residence universe of *leavers* only). Self-flows are
  //              EXCLUDED — outbound on this card means "where do residents
  //              who commute out go," not "all residents."
  //
  // Filter handling: `applySegmentFilter` rewrites each FlowRow's
  // `workerCount` upstream but DOES NOT modify the `segments` block (LODES
  // doesn't publish joint cross-axis cells, so no honest per-axis cell
  // re-projection exists under filter). To keep the mix card internally
  // consistent we therefore drive both the displayed total AND the breakdown
  // values from segment cells — never from `workerCount`. Each axis's three
  // buckets sum to S000 within ±2 (LODES noise infusion); we use the age
  // axis as the canonical total. Net effect: the card shows the full-
  // population OD mix regardless of segment filter — the filter still
  // affects every other card on the strip, but per-axis percentages here
  // stay self-consistent and obey LODES's joint-cell limit.
  const odMixOverride = useMemo<{
    age: AgeBlock;
    wage: WageBlock;
    naics3: Naics3Block;
    total: number;
    title: string;
    subtitle: string;
  } | null>(() => {
    if (!isPerZip || !selectedZip) return null;
    const dataset = mode === 'inbound' ? flowsInbound : flowsOutbound;
    const partnerSet = selectedPartner ? new Set(selectedPartner.zips) : null;

    const age: AgeBlock = { u29: 0, age30to54: 0, age55plus: 0 };
    const wage: WageBlock = { low: 0, mid: 0, high: 0 };
    const naics3: Naics3Block = { goods: 0, tradeTransUtil: 0, allOther: 0 };
    let rowsWithSegments = 0;
    let rowsTotal = 0;

    for (const f of dataset) {
      if (mode === 'inbound') {
        if (f.destZip !== selectedZip) continue;
        if (partnerSet && !partnerSet.has(f.originZip)) continue;
      } else {
        if (f.originZip !== selectedZip) continue;
        // Outbound = leavers only. Drop self-flows so the residence-side
        // mix reflects only residents who commute OUT, not stay-at-home
        // workers.
        if (f.destZip === selectedZip) continue;
        if (partnerSet && !partnerSet.has(f.destZip)) continue;
      }
      rowsTotal += 1;
      if (!f.segments) continue;
      rowsWithSegments += 1;
      age.u29 += f.segments.age.u29;
      age.age30to54 += f.segments.age.age30to54;
      age.age55plus += f.segments.age.age55plus;
      wage.low += f.segments.wage.low;
      wage.mid += f.segments.wage.mid;
      wage.high += f.segments.wage.high;
      naics3.goods += f.segments.naics3.goods;
      naics3.tradeTransUtil += f.segments.naics3.tradeTransUtil;
      naics3.allOther += f.segments.naics3.allOther;
    }

    // Drop the override when no rows match (e.g., partner filter hits a
    // dataset gap) or when none of the matching rows carry a segments
    // block — RAC/WAC fallback gives a sensible card instead of an empty one.
    if (rowsTotal === 0 || rowsWithSegments === 0) return null;

    // Total driven from segment cells (canonical: age sum). Stays
    // self-consistent with the breakdown values regardless of segment
    // filter state — the filter narrows other cards on the strip, not
    // this one.
    const total = age.u29 + age.age30to54 + age.age55plus;
    if (total === 0) return null;

    // Title flips by direction — inbound frames the anchor as a workplace,
    // outbound as a residence. Subtitle reflects scope (partner vs full).
    const title =
      mode === 'inbound'
        ? `${scope} · Workforce mix`
        : `${scope} · Resident workforce mix`;
    const subtitle = selectedPartner
      ? mode === 'inbound'
        ? `OD · from ${selectedPartner.place} · latest year`
        : `OD · to ${selectedPartner.place} · latest year`
      : mode === 'inbound'
        ? 'OD · workforce + within-ZIP · latest year'
        : 'OD · outbound commuters · latest year';

    return { age, wage, naics3, total, title, subtitle };
  }, [
    isPerZip,
    selectedZip,
    mode,
    flowsInbound,
    flowsOutbound,
    selectedPartner,
    scope,
  ]);

  return (
    <div
      className="absolute left-0 right-0 bottom-0 z-20 pointer-events-auto"
      style={{ paddingBottom: 16 }}
    >
      <div
        className="flex gap-2 px-4 overflow-x-auto"
        style={{
          scrollbarWidth: 'thin',
          paddingBottom: 6,
        }}
      >
        <SegmentFilterPanel
          value={segmentFilter}
          onChange={onSegmentFilterChange}
          compact={isPerZip}
        />
        {isPerZip && (
          <CardsForOd
            scope={scope}
            // When a partner is selected, the OD card collapses to a single
            // direction headline carrying just the partner flow's worker
            // count — inflow side in inbound mode, outflow side in outbound.
            // The unrelated direction and the within-ZIP line drop out so the
            // tile reads as the filtered route, not the anchor universe.
            inflowLatest={
              selectedPartner
                ? mode === 'inbound'
                  ? { totalJobs: partnerFlowWorkers }
                  : null
                : blocks.inflowLatest
            }
            inflowTrend={
              selectedPartner
                ? mode === 'inbound'
                  ? partnerTrend
                  : []
                : blocks.inflowTrend
            }
            outflowLatest={
              selectedPartner
                ? mode === 'outbound'
                  ? { totalJobs: partnerFlowWorkers }
                  : null
                : blocks.outflowLatest
            }
            outflowTrend={
              selectedPartner
                ? mode === 'outbound'
                  ? partnerTrend
                  : []
                : blocks.outflowTrend
            }
            withinLatest={selectedPartner ? null : blocks.withinLatest}
            withinTrend={selectedPartner ? [] : blocks.withinTrend}
            trendDomain={odDomain}
          />
        )}
        {isPerZip && selectedZip && (
          <WorkplaceMetricsCard
            scope={scope}
            selectedZip={selectedZip}
            selectedPartner={selectedPartner}
            mode={mode}
            wacLatest={blocks.wacLatest}
            racLatest={blocks.racLatest}
            inflowLatest={blocks.inflowLatest}
            outflowLatest={blocks.outflowLatest}
            withinLatest={blocks.withinLatest}
            topInflowPartner={
              odEntry?.topPartners.inflow.find((p) => p.zip !== 'ALL_OTHER') ?? null
            }
            topOutflowPartner={
              odEntry?.topPartners.outflow.find((p) => p.zip !== 'ALL_OTHER') ?? null
            }
            flowsInbound={flowsInbound}
            flowsOutbound={flowsOutbound}
            zips={zips}
            corridorIndex={corridorIndex}
            flowIndex={flowIndex}
            driveDistance={driveDistance}
            segmentFilter={segmentFilter}
          />
        )}
        <CardsForRacWac
          scope={scope}
          wacLatest={blocks.wacLatest}
          wacTrend={blocks.wacTrend}
          racLatest={blocks.racLatest}
          racTrend={blocks.racTrend}
          mode={mode}
          trendDomain={wacDomain}
          showWacTotal={!isPerZip}
          isAggregate={!isPerZip}
          segmentFilter={segmentFilter}
          odMixOverride={odMixOverride}
        />
        {isPerZip && odEntry && (
          <>
            <Card
              title={`${scope} · Top inflow partners`}
              subtitle="Where workers commute from · latest year"
              width={260}
            >
              <PartnerList
                partners={
                  filterActive
                    ? filterPartners(
                        odEntry.topPartners.inflow,
                        flowsInbound,
                        odEntry.zip,
                        'inflow',
                      )
                    : odEntry.topPartners.inflow
                }
                denominator={
                  (blocks.inflowLatest?.totalJobs ?? 0) +
                  (blocks.withinLatest?.totalJobs ?? 0)
                }
                withinZip={
                  blocks.withinLatest && odEntry.zip
                    ? { zip: odEntry.zip, workers: blocks.withinLatest.totalJobs }
                    : undefined
                }
              />
            </Card>
            <Card
              title={`${scope} · Top outflow partners`}
              subtitle="Where residents commute to · latest year"
              width={260}
            >
              <PartnerList
                partners={
                  filterActive
                    ? filterPartners(
                        odEntry.topPartners.outflow,
                        flowsOutbound,
                        odEntry.zip,
                        'outflow',
                      )
                    : odEntry.topPartners.outflow
                }
                denominator={
                  (blocks.outflowLatest?.totalJobs ?? 0) +
                  (blocks.withinLatest?.totalJobs ?? 0)
                }
                withinZip={
                  blocks.withinLatest && odEntry.zip
                    ? { zip: odEntry.zip, workers: blocks.withinLatest.totalJobs }
                    : undefined
                }
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
