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
}

interface Point {
  x: number;          // year (annual) or year + month/12 (monthly)
  y: number;          // value at active variant
  year: number;
  month?: number;
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

function pickTrend(
  bundle: ContextBundle | null,
  selectedZip: string | null,
): { trend: CommerceTrend | undefined; label: string } {
  if (!bundle) return { trend: undefined, label: '' };
  if (selectedZip) {
    const { place, county } = getPlaceWithRails(bundle, 'commerce', selectedZip);
    const placeTrend = place?.trend as CommerceTrend | undefined;
    if (placeTrend && (placeTrend.annual?.length ?? 0) > 0) {
      return { trend: placeTrend, label: place?.name ?? '' };
    }
    const countyTrend = county?.trend as CommerceTrend | undefined;
    if (countyTrend && (countyTrend.annual?.length ?? 0) > 0) {
      return { trend: countyTrend, label: county?.name ?? '' };
    }
  }
  const env = bundle.commerce;
  if (!env) return { trend: undefined, label: '' };
  const garfield = env.counties.find((c) => c.geoid === '08045');
  return {
    trend: garfield?.trend as CommerceTrend | undefined,
    label: garfield?.name ?? '',
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
}: Props) {
  const { trend, label } = useMemo(
    () => pickTrend(bundle, selectedZip),
    [bundle, selectedZip],
  );
  const points = useMemo(
    () => buildPoints(trend, cadence, variant),
    [trend, cadence, variant],
  );

  // Layout — viewBox-based, so the SVG stretches to its container.
  const W = 720;
  const H = 240;
  const M = { top: 8, right: 16, bottom: 24, left: 56 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const { sx, sy, yMax, xMin, xMax } = useMemo(() => {
    if (points.length === 0) {
      return {
        sx: scaleLinear().domain([0, 1]).range([0, innerW]),
        sy: scaleLinear().domain([0, 1]).range([innerH, 0]),
        yMax: 0,
        xMin: 0,
        xMax: 0,
      };
    }
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMax = Math.max(...ys, 0);
    const sx = scaleLinear().domain([xMin, xMax || xMin + 1]).range([0, innerW]);
    // Y always anchored at zero per spec — gridline visible at 0.
    const sy = scaleLinear().domain([0, yMax * 1.05 || 1]).range([innerH, 0]);
    return { sx, sy, yMax, xMin, xMax };
  }, [points, innerW, innerH]);

  const linePath = useMemo(() => {
    if (points.length === 0) return '';
    return (
      d3Line<Point>()
        .x((d) => sx(d.x))
        .y((d) => sy(d.y))(points) ?? ''
    );
  }, [points, sx, sy]);

  const areaPath = useMemo(() => {
    if (points.length === 0) return '';
    return (
      d3Area<Point>()
        .x((d) => sx(d.x))
        .y0(innerH)
        .y1((d) => sy(d.y))(points) ?? ''
    );
  }, [points, sx, sy, innerH]);

  // Y-axis ticks (4 nice steps).
  const yTicks = useMemo(() => sy.ticks(4), [sy]);
  // X-axis ticks: 5–7 across the range, prefer multiples of 5 for years.
  const xTicks = useMemo(() => {
    if (points.length === 0) return [];
    const span = xMax - xMin;
    const step = span > 20 ? 5 : span > 10 ? 2 : span > 4 ? 1 : 0.5;
    const out: number[] = [];
    const start = Math.ceil(xMin / step) * step;
    for (let v = start; v <= xMax + 0.0001; v += step) out.push(v);
    return out;
  }, [points, xMin, xMax]);

  // Tooltip state — index into the points array of the focused row.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Map a viewBox-space x coordinate (within plot bounds) → nearest point
  // index. Using nearest-by-x is robust to either cadence.
  const xToIndex = (xViewBox: number): number | null => {
    if (points.length === 0) return null;
    const xData = sx.invert(xViewBox);
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].x - xData);
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

  const focused = hoverIdx != null ? points[hoverIdx] : null;

  const variantLabel = COMMERCE_VARIANT_LABEL[variant];
  const subtitle = label
    ? `${label} · ${cadence === 'annual' ? 'annual' : 'monthly'}`
    : `${cadence === 'annual' ? 'annual' : 'monthly'}`;

  // Tooltip x/y position in % of viewBox so we can absolutely-position the
  // floating label over the SVG container.
  const tooltipPct = useMemo(() => {
    if (!focused) return null;
    const cx = M.left + sx(focused.x);
    const cy = M.top + sy(focused.y);
    return { left: (cx / W) * 100, top: (cy / H) * 100 };
  }, [focused, sx, sy, M.left, M.top]);

  return (
    <ChartFrame
      title={`Sales · ${variantLabel}`}
      subtitle={subtitle}
    >
      {/* Toggles row */}
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
      </div>

      {points.length === 0 ? (
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
              {/* Area + line */}
              <path d={areaPath} fill="url(#commerce-area-grad)" />
              <path
                d={linePath}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={1.6}
                vectorEffect="non-scaling-stroke"
              />
              {/* Hover guide + dot */}
              {focused && (
                <g>
                  <line
                    x1={sx(focused.x)}
                    x2={sx(focused.x)}
                    y1={0}
                    y2={innerH}
                    stroke="var(--accent)"
                    strokeOpacity={0.5}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={sx(focused.x)}
                    cy={sy(focused.y)}
                    r={3.5}
                    fill="var(--accent)"
                    stroke="var(--bg-base, #0b0d10)"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
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
              <div className="tnum" style={{ color: 'var(--accent)' }}>
                {fmtCompactUSD(focused.y)}
              </div>
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
