// CommerceTimeSeriesChart — full-size time-series card for the Dashboard's
// Commerce section. Replaces the sparkline-inside-headline-card pattern with
// a real chart: zero-anchored y-axis, year/month tick labels, and a hover
// tooltip that surfaces the value at the focused x position.
//
// Data path mirrors the existing CommerceSparkline (in ContextCards.tsx):
//   - selected place trend (when a workplace ZIP is selected)
//   - fall back to its containing county
//   - fall back to Garfield County (the central county in the study area)
// so the chart always has something to render.
//
// Variant + cadence are fully controlled by the parent (DashboardView). The
// toggles render in the chart's header so the user can pivot the active
// measure / cadence without leaving the chart.

import { useMemo, useState } from 'react';
import { line as d3Line, area as d3Area } from 'd3-shape';
import { scaleLinear } from 'd3-scale';
import type {
  CommerceAnnualRow,
  CommerceMonthlyRow,
  CommerceTrend,
  ContextBundle,
} from '../../types/context';
import { getPlaceWithRails } from '../../lib/contextQueries';
import { fmtCompactUSD } from '../../lib/format';
import {
  COMMERCE_CADENCE_LABEL,
  COMMERCE_VARIANT_CHIP_LABEL,
  COMMERCE_VARIANT_LABEL,
  COMMERCE_VARIANT_TREND_KEY,
  VariantToggle,
  type CommerceCadence,
  type CommerceVariant,
} from '../ContextCards';
import { ChartFrame } from './HousingMarketSection';

interface Props {
  bundle: ContextBundle | null;
  selectedZip: string | null;
  variant: CommerceVariant;
  cadence: CommerceCadence;
  onVariantChange: (v: CommerceVariant) => void;
  onCadenceChange: (v: CommerceCadence) => void;
  // When set in multi-series (no-anchor) mode, the matching county's
  // line renders in amber (var(--accent)) and is brought to the front;
  // the other lines stay rendered in their grey palette so the chart
  // still shows the comparison context.
  highlightCountyGeoid?: string | null;
}

interface Point {
  x: number;          // year (annual) or year + month/12 (monthly)
  y: number;          // value at active variant
  year: number;
  month?: number;
}

interface Series {
  key: string;
  label: string;
  color: string;
  points: Point[];
}

function buildPoints(
  trend: CommerceTrend | undefined,
  cadence: CommerceCadence,
  variant: CommerceVariant,
): Point[] {
  if (!trend) return [];
  const measure = COMMERCE_VARIANT_TREND_KEY[variant];
  const rows = cadence === 'annual' ? trend.annual : trend.monthly;
  if (!rows || rows.length === 0) return [];
  return rows.map((r) => {
    const yr = (r as CommerceAnnualRow).year;
    const mo = (r as CommerceMonthlyRow).month;
    const y = (r as CommerceAnnualRow | CommerceMonthlyRow)[measure];
    const x = cadence === 'monthly' ? yr + (mo ?? 0) / 12 : yr;
    return { x, y, year: yr, month: mo };
  });
}

// Three-county series ordering for the aggregate (no-anchor) view. Colors
// match the COUNTY_TINT palette used by the bar/pie charts so the user
// reads the same Garfield/Eagle/Pitkin grouping consistently across the
// Commerce section.
const COUNTY_SERIES_SPEC: Array<{ geoid: string; color: string }> = [
  { geoid: '08045', color: 'var(--corridor-1)' }, // Garfield
  { geoid: '08037', color: 'var(--corridor-3)' }, // Eagle
  { geoid: '08097', color: 'var(--corridor-2)' }, // Pitkin
];

function buildSeries(
  bundle: ContextBundle | null,
  selectedZip: string | null,
  cadence: CommerceCadence,
  variant: CommerceVariant,
): { series: Series[]; subtitleLabel: string; isMulti: boolean } {
  if (!bundle) return { series: [], subtitleLabel: '', isMulti: false };
  if (selectedZip) {
    const { place, county } = getPlaceWithRails(bundle, 'commerce', selectedZip);
    const placeTrend = place?.trend as CommerceTrend | undefined;
    if (placeTrend && (placeTrend.annual?.length ?? 0) > 0) {
      const points = buildPoints(placeTrend, cadence, variant);
      return {
        series: [{ key: 'sel', label: place?.name ?? '', color: 'var(--accent)', points }],
        subtitleLabel: place?.name ?? '',
        isMulti: false,
      };
    }
    const countyTrend = county?.trend as CommerceTrend | undefined;
    if (countyTrend && (countyTrend.annual?.length ?? 0) > 0) {
      const points = buildPoints(countyTrend, cadence, variant);
      return {
        series: [{ key: 'sel', label: county?.name ?? '', color: 'var(--accent)', points }],
        subtitleLabel: county?.name ?? '',
        isMulti: false,
      };
    }
  }
  // Aggregate (no anchor selected) — compare Garfield, Eagle, and Pitkin
  // counties as three lines on a shared y-axis. Mesa is excluded for the
  // same reason it's hidden from the headline rail (De Beque-only sliver
  // that distorts the Roaring Fork picture).
  const env = bundle.commerce;
  if (!env) return { series: [], subtitleLabel: '', isMulti: false };
  const series: Series[] = [];
  for (const spec of COUNTY_SERIES_SPEC) {
    const c = env.counties.find((x) => x.geoid === spec.geoid);
    if (!c) continue;
    const points = buildPoints(c.trend as CommerceTrend | undefined, cadence, variant);
    if (points.length === 0) continue;
    series.push({
      key: spec.geoid,
      label: c.name.replace(/ County$/, ''),
      color: spec.color,
      points,
    });
  }
  return {
    series,
    subtitleLabel: series.map((s) => s.label).join(' · '),
    isMulti: true,
  };
}

function fmtMonthLabel(month: number | undefined): string {
  if (month == null) return '';
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[Math.max(0, Math.min(11, month - 1))] ?? '';
}

export function CommerceTimeSeriesChart({
  bundle,
  selectedZip,
  variant,
  cadence,
  onVariantChange,
  onCadenceChange,
  highlightCountyGeoid = null,
}: Props) {
  const { series, subtitleLabel, isMulti } = useMemo(
    () => buildSeries(bundle, selectedZip, cadence, variant),
    [bundle, selectedZip, cadence, variant],
  );
  // Flat union of all points used for scale-domain calculation. Anchor x
  // ticks against this so all series share an x-axis.
  const allPoints = useMemo(
    () => series.flatMap((s) => s.points),
    [series],
  );
  // Primary series — drives single-series rendering (area gradient + dot).
  // In multi-series mode it's still useful as the hover anchor (we show
  // the focused x's value across every series in the tooltip, but the
  // x-snap index uses the longest series so monthly cadence stays
  // accurate even if one county has a shorter tail).
  const primarySeries = useMemo(() => {
    if (series.length === 0) return null;
    return series.reduce((best, s) =>
      s.points.length > (best?.points.length ?? 0) ? s : best,
      series[0],
    );
  }, [series]);

  // Layout — viewBox-based, so the SVG stretches to its container.
  const W = 720;
  const H = 240;
  const M = { top: 8, right: 16, bottom: 24, left: 56 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const { sx, sy, yMax, xMin, xMax } = useMemo(() => {
    if (allPoints.length === 0) {
      return {
        sx: scaleLinear().domain([0, 1]).range([0, innerW]),
        sy: scaleLinear().domain([0, 1]).range([innerH, 0]),
        yMax: 0,
        xMin: 0,
        xMax: 0,
      };
    }
    const xs = allPoints.map((p) => p.x);
    const ys = allPoints.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMax = Math.max(...ys, 0);
    const sx = scaleLinear().domain([xMin, xMax || xMin + 1]).range([0, innerW]);
    // Y always anchored at zero per spec — gridline visible at 0.
    const sy = scaleLinear().domain([0, yMax * 1.05 || 1]).range([innerH, 0]);
    return { sx, sy, yMax, xMin, xMax };
  }, [allPoints, innerW, innerH]);

  // One d3-shape line generator shared across series — only the data
  // changes per series.
  const lineGen = useMemo(
    () =>
      d3Line<Point>()
        .x((d) => sx(d.x))
        .y((d) => sy(d.y)),
    [sx, sy],
  );

  // Area path is only used in single-series mode (overlapping fills get
  // muddy with three counties). In multi-series mode we render lines only.
  const primaryAreaPath = useMemo(() => {
    if (isMulti || !primarySeries || primarySeries.points.length === 0) return '';
    return (
      d3Area<Point>()
        .x((d) => sx(d.x))
        .y0(innerH)
        .y1((d) => sy(d.y))(primarySeries.points) ?? ''
    );
  }, [isMulti, primarySeries, sx, sy, innerH]);

  // Y-axis ticks (4 nice steps).
  const yTicks = useMemo(() => sy.ticks(4), [sy]);
  // X-axis ticks: 5–7 across the range, prefer multiples of 5 for years.
  const xTicks = useMemo(() => {
    if (allPoints.length === 0) return [];
    const span = xMax - xMin;
    const step = span > 20 ? 5 : span > 10 ? 2 : span > 4 ? 1 : 0.5;
    const out: number[] = [];
    const start = Math.ceil(xMin / step) * step;
    for (let v = start; v <= xMax + 0.0001; v += step) out.push(v);
    return out;
  }, [allPoints, xMin, xMax]);

  // Tooltip state — index into the longest (primary) series, used as the
  // x-snap target. Each series' value at that x is then resolved
  // independently for the tooltip + dots.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const xToIndex = (xViewBox: number): number | null => {
    if (!primarySeries || primarySeries.points.length === 0) return null;
    const xData = sx.invert(xViewBox);
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < primarySeries.points.length; i++) {
      const d = Math.abs(primarySeries.points[i].x - xData);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  };

  const handleMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const inv = ctm.inverse();
    const local = pt.matrixTransform(inv);
    const xInPlot = local.x - M.left;
    if (xInPlot < 0 || xInPlot > innerW) return;
    const idx = xToIndex(xInPlot);
    if (idx != null) setHoverIdx(idx);
  };

  const focused = hoverIdx != null && primarySeries
    ? primarySeries.points[hoverIdx] ?? null
    : null;

  // For each non-primary series, find the row whose x matches the focused
  // x (or nearest match). Used to draw per-series dots and tooltip rows.
  const focusedBySeries = useMemo(() => {
    if (!focused) return [] as Array<{ series: Series; point: Point | null }>;
    return series.map((s) => {
      let best: Point | null = null;
      let bestDist = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.x - focused.x);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      // Only consider it a match if within half a year for monthly, or
      // exact for annual — avoids drawing dots on far-away points.
      const tol = cadence === 'monthly' ? 0.25 : 0.01;
      return { series: s, point: best && bestDist <= tol ? best : null };
    });
  }, [series, focused, cadence]);

  const variantLabel = COMMERCE_VARIANT_LABEL[variant];
  const cadenceLabel = cadence === 'annual' ? 'annual' : 'monthly';
  const subtitle = subtitleLabel
    ? `${subtitleLabel} · ${cadenceLabel}`
    : cadenceLabel;

  // Tooltip x/y position in % of viewBox so we can absolutely-position the
  // floating label over the SVG container. y anchors to the highest
  // series value at the focused x, so the tooltip floats above the
  // tallest dot in multi-series mode.
  const tooltipPct = useMemo(() => {
    if (!focused) return null;
    let yMaxAtX = focused.y;
    for (const fs of focusedBySeries) {
      if (fs.point && fs.point.y > yMaxAtX) yMaxAtX = fs.point.y;
    }
    const cx = M.left + sx(focused.x);
    const cy = M.top + sy(yMaxAtX);
    return { left: (cx / W) * 100, top: (cy / H) * 100 };
  }, [focused, focusedBySeries, sx, sy, M.left, M.top]);

  return (
    <ChartFrame
      title={`Sales · ${variantLabel}`}
      subtitle={subtitle}
    >
      {/* Toggles + multi-series legend share one row so the legend sits
          to the right of the variant/cadence buttons rather than wrapping
          to a second line. */}
      <div className="flex items-center gap-3 flex-wrap">
        <VariantToggle<CommerceVariant>
          value={variant}
          onChange={onVariantChange}
          options={['gross', 'retail', 'taxable']}
          labels={COMMERCE_VARIANT_CHIP_LABEL}
          ariaLabel="CDOR sales metric"
        />
        <VariantToggle<CommerceCadence>
          value={cadence}
          onChange={onCadenceChange}
          options={['annual', 'monthly']}
          labels={COMMERCE_CADENCE_LABEL}
          ariaLabel="Trend cadence"
        />
        {isMulti && series.length > 0 && (
          <div
            className="flex items-center gap-3 flex-wrap text-[10px] mt-1.5"
            aria-label="County series legend"
          >
            {series.map((s) => {
              const isHighlighted = highlightCountyGeoid != null && s.key === highlightCountyGeoid;
              return (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block rounded-sm"
                    style={{
                      width: 10,
                      height: 2,
                      background: isHighlighted ? 'var(--accent)' : s.color,
                      opacity: 0.95,
                    }}
                  />
                  <span
                    style={{
                      color: isHighlighted ? 'var(--accent)' : 'var(--text-h)',
                      fontWeight: isHighlighted ? 600 : 400,
                    }}
                  >
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {allPoints.length === 0 ? (
        <div
          className="text-[11px] py-6"
          style={{ color: 'var(--text-dim)' }}
        >
          No commerce trend available.
        </div>
      ) : (
        <div
          className="relative w-full flex-1 flex flex-col"
          style={{ minHeight: 240 }}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="w-full h-full"
            style={{ display: 'block', flex: 1, minHeight: 200 }}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id="commerce-area-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g transform={`translate(${M.left}, ${M.top})`}>
              {/* Y gridlines + tick labels (zero baseline included) */}
              {yTicks.map((t) => (
                <g key={t}>
                  <line
                    x1={0}
                    x2={innerW}
                    y1={sy(t)}
                    y2={sy(t)}
                    stroke="var(--panel-border)"
                    strokeDasharray={t === 0 ? undefined : '2 3'}
                  />
                  <text
                    x={-6}
                    y={sy(t)}
                    fontSize="9"
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill="var(--text-dim)"
                  >
                    {fmtCompactUSD(t)}
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
                  {Math.round(t)}
                </text>
              ))}
              {/* Area gradient — only in single-series mode. */}
              {!isMulti && primaryAreaPath && (
                <path d={primaryAreaPath} fill="url(#commerce-area-grad)" />
              )}
              {/* One line per series. When a county is highlighted in
                  multi-series mode, the matching line renders in amber
                  with a heavier stroke and draws last (on top). The
                  rest are dimmed slightly but still legible. */}
              {[...series]
                .sort((a, b) => {
                  if (!isMulti || !highlightCountyGeoid) return 0;
                  if (a.key === highlightCountyGeoid) return 1;
                  if (b.key === highlightCountyGeoid) return -1;
                  return 0;
                })
                .map((s) => {
                  const isHighlighted = isMulti && highlightCountyGeoid != null && s.key === highlightCountyGeoid;
                  const isDimmed = isMulti && highlightCountyGeoid != null && !isHighlighted;
                  return (
                    <path
                      key={s.key}
                      d={lineGen(s.points) ?? ''}
                      fill="none"
                      stroke={isHighlighted ? 'var(--accent)' : s.color}
                      strokeWidth={isHighlighted ? 2.2 : 1.6}
                      strokeOpacity={isDimmed ? 0.55 : 0.95}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              {/* Hover guide + per-series dots. */}
              {focused && (
                <g>
                  <line
                    x1={sx(focused.x)}
                    x2={sx(focused.x)}
                    y1={0}
                    y2={innerH}
                    stroke="var(--text-dim)"
                    strokeOpacity={0.6}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  {focusedBySeries.map(({ series: s, point }) => {
                    if (!point) return null;
                    const isHighlighted =
                      isMulti && highlightCountyGeoid != null && s.key === highlightCountyGeoid;
                    return (
                      <circle
                        key={s.key}
                        cx={sx(point.x)}
                        cy={sy(point.y)}
                        r={isHighlighted ? 4 : 3.5}
                        fill={isHighlighted ? 'var(--accent)' : s.color}
                        stroke="var(--bg-base, #0b0d10)"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
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
          {/* Floating tooltip (HTML so text stays crisp regardless of SVG scale) */}
          {focused && tooltipPct && (
            <div
              className="pointer-events-none absolute rounded-md px-2 py-1 text-[10px]"
              style={{
                left: `${Math.min(95, Math.max(0, tooltipPct.left))}%`,
                top: `${Math.max(0, tooltipPct.top)}%`,
                transform: 'translate(-50%, calc(-100% - 10px))',
                background: 'rgba(11, 13, 16, 0.92)',
                border: '1px solid var(--panel-border)',
                color: 'var(--text-h)',
                whiteSpace: 'nowrap',
                lineHeight: 1.4,
              }}
            >
              <div style={{ color: 'var(--text-dim)' }}>
                {cadence === 'annual'
                  ? `${focused.year}`
                  : `${fmtMonthLabel(focused.month)} ${focused.year}`}
              </div>
              {isMulti ? (
                <div className="flex flex-col gap-0.5 mt-0.5">
                  {focusedBySeries
                    .filter((fs) => fs.point != null)
                    .map((fs) => {
                      const isHighlighted =
                        highlightCountyGeoid != null && fs.series.key === highlightCountyGeoid;
                      return (
                        <div
                          key={fs.series.key}
                          className="flex items-center gap-2 tnum"
                        >
                          <span
                            className="inline-block rounded-sm"
                            style={{
                              width: 8,
                              height: 8,
                              background: isHighlighted ? 'var(--accent)' : fs.series.color,
                              opacity: 0.95,
                            }}
                          />
                          <span
                            style={{
                              color: isHighlighted ? 'var(--accent)' : 'var(--text-dim)',
                              fontWeight: isHighlighted ? 600 : 400,
                            }}
                          >
                            {fs.series.label}
                          </span>
                          <span style={{ color: 'var(--text-h)', marginLeft: 'auto' }}>
                            {fmtCompactUSD(fs.point!.y)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="tnum" style={{ color: 'var(--accent)' }}>
                  {fmtCompactUSD(focused.y)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Spacer so the floor of the chart card sits below the chart cleanly */}
      {/* (kept empty intentionally — ChartFrame applies its own gap) */}
      {yMax === 0 && null}
    </ChartFrame>
  );
}
