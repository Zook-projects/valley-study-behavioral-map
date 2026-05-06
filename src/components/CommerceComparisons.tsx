// CommerceComparisons — three horizontal-bar comparison charts that sit
// below the Commerce card in the dashboard's Commerce section. All three
// share the active variant (Gross / Retail / Taxable) and react to the
// same workplace selection as the rest of the dashboard.
//
//   1. Counties      — all 4 counties (Eagle, Garfield, Mesa, Pitkin) on
//                      latest-year totals. Mesa is INCLUDED here even
//                      though it's hidden from the Commerce card's
//                      aggregate view (Mesa = De Beque only, distracting
//                      noise in the headline rail). At the comparison
//                      tier the user is asking for peer-county scale, so
//                      the full set surfaces.
//   2. Anchor places — 11 anchor ZIPs ranked on the same variant. Bars
//                      are tinted by their containing county for visual
//                      grouping; the actively selected workplace ZIP is
//                      highlighted in the accent color.
//   3. County share  — each anchor place's share of its containing
//                      county for the active variant, rendered as bars
//                      in [0, 100%]. Surfaces the contribution context
//                      hinted at by the in-card "(X% of County)" label.

import { useMemo, useState } from 'react';
import { arc as d3Arc, pie as d3Pie, type PieArcDatum } from 'd3-shape';
import type {
  CommerceAnnualRow,
  CommerceTrend,
  ContextBundle,
  ContextCountyEntry,
  ContextPlaceEntry,
} from '../types/context';
import { fmtCompactUSD } from '../lib/format';
import {
  COMMERCE_VARIANT_TREND_KEY,
  type CommerceVariant,
} from './ContextCards';

interface Props {
  bundle: ContextBundle | null;
  selectedZip: string | null;
  variant: CommerceVariant;
  // When provided, the Anchor Places + Place Share rows become clickable
  // and call this with the row's ZIP. Toggling the same row off (i.e.,
  // clicking the currently selected anchor) is the parent's job — pass
  // null when the same ZIP is being deselected.
  onSelectPlace?: (zip: string | null) => void;
  // Active county filter (FIPS GEOID, e.g. "08045"). Drives:
  //   - the Counties card highlight (selected county shows in amber)
  //   - the Anchor place mix pie's slice set (only places whose
  //     containing county matches the selection appear)
  // The line-chart highlight in CommerceTimeSeriesChart is wired through
  // the same value at the parent level, not from this component.
  selectedCountyGeoid?: string | null;
  onSelectCounty?: (geoid: string | null) => void;
}

// Counties intentionally hidden from the Counties card. Mesa is the
// western-edge county (De Beque sliver only) — including it skews the
// bar chart and reads as outlier context that distracts from the core
// Roaring Fork picture.
const HIDDEN_COUNTY_GEOIDS = new Set(['08077']);

// Value-driven gradient endpoints used across the three Commerce
// comparison charts (Counties bar, Anchor places bar, Anchor place mix
// pie). Higher values render closer to GRADIENT_HIGH (light grey), lower
// values closer to GRADIENT_LOW (dark grey). Greyscale keeps the value
// channel legible without competing with the amber accent reserved for
// the active selection.
const GRADIENT_LOW = '#3a3d44';
const GRADIENT_HIGH = '#d4d6dc';

function lerpHex(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const s = h.replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)] as const;
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const k = clamp(t);
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const blue = Math.round(ab + (bb - ab) * k);
  return `#${[r, g, blue].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function colorForValue(value: number, min: number, max: number): string {
  if (!isFinite(value)) return GRADIENT_LOW;
  if (max <= min) return GRADIENT_HIGH;
  return lerpHex(GRADIENT_LOW, GRADIENT_HIGH, (value - min) / (max - min));
}

function pickAnnualLatest(
  trend: CommerceTrend | undefined,
  measure: 'gross' | 'retail' | 'taxable',
): { year: number; value: number } | null {
  if (!trend) return null;
  const annual = trend.annual ?? [];
  if (annual.length === 0) return null;
  const last = annual[annual.length - 1] as CommerceAnnualRow;
  return { year: last.year, value: last[measure] };
}

interface BarRow {
  key: string;
  label: string;
  value: number;
  highlight?: boolean;
  fill?: string;
}

function HorizontalBars({
  rows,
  formatValue,
  emptyLabel,
  ariaLabel,
  axisMax,
  onRowClick,
}: {
  rows: BarRow[];
  formatValue: (v: number) => string;
  emptyLabel: string;
  ariaLabel: string;
  // Optional hard upper bound for the axis. When omitted, derived from the
  // max value in `rows`.
  axisMax?: number;
  // When provided, each row becomes a button that calls this with its
  // `key`. The current implementation in CommerceComparisons routes that
  // through to a ZIP-keyed selection callback in DashboardView.
  onRowClick?: (key: string) => void;
}) {
  const max = useMemo(() => {
    if (axisMax !== undefined) return axisMax;
    return rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  }, [rows, axisMax]);

  if (rows.length === 0) {
    return (
      <div
        className="text-[11px] py-2"
        style={{ color: 'var(--text-dim)' }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul
      className="flex flex-col gap-1"
      role="list"
      aria-label={ariaLabel}
    >
      {rows.map((r) => {
        const pct = (r.value / max) * 100;
        const fill = r.highlight ? 'var(--accent)' : (r.fill ?? 'var(--corridor-1)');
        const clickable = onRowClick != null;
        const inner = (
          <>
            <span
              className="text-[10px] truncate text-left"
              style={{
                color: r.highlight ? 'var(--accent)' : 'var(--text-h)',
                fontWeight: r.highlight ? 600 : 400,
              }}
              title={r.label}
            >
              {r.label}
            </span>
            <div
              className="relative rounded-sm"
              style={{
                height: 10,
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--panel-border)',
              }}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-sm"
                style={{
                  width: `${Math.max(0, Math.min(100, pct))}%`,
                  background: fill,
                  opacity: r.highlight ? 0.95 : 0.55,
                }}
              />
            </div>
            <span
              className="text-[10px] tnum text-right"
              style={{ color: 'var(--text-dim)' }}
            >
              {formatValue(r.value)}
            </span>
          </>
        );
        return (
          <li
            key={r.key}
            className="grid items-center gap-2"
            style={{
              gridTemplateColumns: '120px 1fr 70px',
            }}
          >
            {clickable ? (
              <button
                type="button"
                onClick={() => onRowClick?.(r.key)}
                aria-pressed={!!r.highlight}
                className="grid items-center gap-2 text-left rounded-sm transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 px-1 -mx-1 py-0.5"
                style={{
                  gridTemplateColumns: '120px 1fr 70px',
                  // The button spans the full row's grid columns by
                  // re-declaring its own grid; the parent <li> still
                  // governs vertical rhythm.
                  gridColumn: '1 / -1',
                }}
              >
                {inner}
              </button>
            ) : (
              inner
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface PieSlice {
  key: string;
  label: string;
  countyName: string;
  value: number;
  fill: string;
  highlight: boolean;
  // When false, the slice + legend row are rendered as non-clickable
  // text. Used for synthetic "Unincorporated {county}" slices that
  // represent the county-total residual and can't be scoped to a ZIP.
  interactive?: boolean;
}

/**
 * Donut/pie chart for the 11 anchor places' contribution to the combined
 * anchor-place total on the active variant. Slices are colored by
 * containing county (same palette as the bar charts) so the user can
 * read both the place ranking and the county grouping at a glance.
 *
 * - Hover a slice → highlights it and surfaces a corner tooltip with
 *   the place name, value, and % of anchor total.
 * - Click a slice → scopes the dashboard to that anchor (same handler
 *   pattern as the bar charts).
 * - The legend on the right mirrors the slice list and is itself
 *   click-to-scope.
 */
function PiePlaces({
  slices,
  formatValue,
  emptyLabel,
  ariaLabel,
  onSliceClick,
  centerLabel = 'ANCHOR TOTAL',
}: {
  slices: PieSlice[];
  formatValue: (v: number) => string;
  emptyLabel: string;
  ariaLabel: string;
  onSliceClick?: (key: string) => void;
  // Static center label shown when no slice is hovered. Defaults to
  // "ANCHOR TOTAL"; the parent overrides this when the pie includes
  // unincorporated remainders (so the center reads as the actual
  // total — e.g. "GARFIELD + PITKIN" or "GARFIELD COUNTY" — rather
  // than the misleading "ANCHOR TOTAL").
  centerLabel?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const total = useMemo(
    () => slices.reduce((s, x) => s + (x.value > 0 ? x.value : 0), 0),
    [slices],
  );

  const arcs = useMemo(() => {
    if (slices.length === 0 || total <= 0) return [];
    const pieGen = d3Pie<PieSlice>()
      .value((d) => d.value)
      // Preserve incoming sort (largest → smallest by value, set in the
      // parent useMemo below) so the pie reads clockwise from 12 o'clock
      // in descending size.
      .sort(null);
    return pieGen(slices);
  }, [slices, total]);

  const VB = 200;
  const cx = VB / 2;
  const cy = VB / 2;
  const arcGen = useMemo(
    () =>
      d3Arc<PieArcDatum<PieSlice>>()
        .innerRadius(VB * 0.22)
        .outerRadius(VB * 0.46)
        .padAngle(0.006),
    [],
  );

  if (slices.length === 0 || total <= 0) {
    return (
      <div className="text-[11px] py-2" style={{ color: 'var(--text-dim)' }}>
        {emptyLabel}
      </div>
    );
  }

  const hovered = hover ? slices.find((s) => s.key === hover) : null;
  const clickEnabled = !!onSliceClick;
  const isInteractive = (s: PieSlice) => clickEnabled && s.interactive !== false;

  return (
    <div className="flex gap-3 items-stretch min-w-0">
      <div className="relative shrink-0" style={{ width: VB, height: VB }}>
        <svg
          viewBox={`0 0 ${VB} ${VB}`}
          width={VB}
          height={VB}
          role="img"
          aria-label={ariaLabel}
        >
          <g transform={`translate(${cx}, ${cy})`}>
            {arcs.map((a) => {
              const data = a.data;
              const isHover = hover === data.key;
              const dim = hover != null && !isHover && !data.highlight;
              const path = arcGen(a) ?? '';
              return (
                <path
                  key={data.key}
                  d={path}
                  fill={data.fill}
                  stroke={
                    data.highlight
                      ? 'var(--accent)'
                      : isHover
                      ? 'var(--text-h)'
                      : 'transparent'
                  }
                  strokeWidth={data.highlight || isHover ? 1.5 : 0}
                  opacity={dim ? 0.4 : data.highlight || isHover ? 1 : 0.85}
                  style={{
                    cursor: isInteractive(data) ? 'pointer' : 'default',
                    transition: 'opacity 120ms ease, stroke 120ms ease',
                  }}
                  onMouseEnter={() => setHover(data.key)}
                  onMouseLeave={() => setHover(null)}
                  onClick={
                    isInteractive(data) ? () => onSliceClick?.(data.key) : undefined
                  }
                />
              );
            })}
            {/* Center label: total or hovered slice. */}
            <text
              textAnchor="middle"
              dominantBaseline="central"
              y={-6}
              style={{ fill: 'var(--text-dim)', fontSize: 8, letterSpacing: 0.5 }}
            >
              {hovered ? hovered.label.toUpperCase() : centerLabel}
            </text>
            <text
              textAnchor="middle"
              dominantBaseline="central"
              y={6}
              style={{
                fill: hovered ? 'var(--accent)' : 'var(--text-h)',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {hovered ? formatValue(hovered.value) : formatValue(total)}
            </text>
            {hovered && (
              <text
                textAnchor="middle"
                dominantBaseline="central"
                y={18}
                style={{ fill: 'var(--text-dim)', fontSize: 9 }}
              >
                {((hovered.value / total) * 100).toFixed(1)}% of total
              </text>
            )}
          </g>
        </svg>
      </div>
      <ul
        className="flex-1 min-w-0 flex flex-col gap-0.5"
        role="list"
        aria-label={ariaLabel}
      >
        {slices.map((s) => {
          const pct = (s.value / total) * 100;
          const isHover = hover === s.key;
          const inner = (
            <>
              <span
                className="inline-block rounded-sm shrink-0"
                style={{ width: 8, height: 8, background: s.fill, opacity: 0.85 }}
              />
              <span
                className="text-[10px] truncate text-left"
                style={{
                  color: s.highlight ? 'var(--accent)' : 'var(--text-h)',
                  fontWeight: s.highlight ? 600 : 400,
                }}
                title={`${s.label} → ${s.countyName}`}
              >
                {s.label}
              </span>
              <span
                className="text-[10px] tnum text-right"
                style={{ color: 'var(--text-dim)' }}
              >
                {pct.toFixed(1)}%
              </span>
            </>
          );
          return (
            <li
              key={s.key}
              className="grid items-center gap-1.5"
              style={{ gridTemplateColumns: '10px 1fr 40px' }}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
            >
              {isInteractive(s) ? (
                <button
                  type="button"
                  onClick={() => onSliceClick?.(s.key)}
                  aria-pressed={s.highlight}
                  className="grid items-center gap-1.5 text-left rounded-sm transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 px-1 -mx-1 py-0.5"
                  style={{
                    gridTemplateColumns: '10px 1fr 40px',
                    gridColumn: '1 / -1',
                    background: isHover ? 'rgba(255,255,255,0.04)' : 'transparent',
                  }}
                >
                  {inner}
                </button>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChartCard({
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
      className="glass rounded-md p-3 flex flex-col gap-2 min-w-0"
    >
      <div>
        <div
          className="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            className="text-[9px] mt-0.5"
            style={{ color: 'var(--text-dim)' }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

export function CommerceComparisons({
  bundle,
  selectedZip,
  variant,
  onSelectPlace,
  selectedCountyGeoid = null,
  onSelectCounty,
}: Props) {
  // Toggle helper: clicking the currently selected anchor clears the
  // filter; clicking any other anchor sets it. Mirrors how the rest of
  // the dashboard treats "click again to deselect."
  const handleRowClick = onSelectPlace
    ? (zip: string) => onSelectPlace(zip === selectedZip ? null : zip)
    : undefined;
  const handleCountyClick = onSelectCounty
    ? (geoid: string) =>
        onSelectCounty(geoid === selectedCountyGeoid ? null : geoid)
    : undefined;
  const measure = COMMERCE_VARIANT_TREND_KEY[variant];

  const { countyRows, placeRows, pieSlices, latestYear } = useMemo(() => {
    if (!bundle) {
      return { countyRows: [], placeRows: [], pieSlices: [], latestYear: null };
    }
    const env = bundle.commerce;
    if (!env) return { countyRows: [], placeRows: [], pieSlices: [], latestYear: null };

    let latestYear: number | null = null;

    // Counties — sorted descending on the active variant. Filter out
    // counties on the editorial hide list (currently Mesa) before any
    // value-domain math so the gradient + sort key off the visible set.
    const countyData = env.counties
      .filter((c) => !HIDDEN_COUNTY_GEOIDS.has(c.geoid))
      .map((c: ContextCountyEntry) => {
        const latest = pickAnnualLatest(c.trend as unknown as CommerceTrend | undefined, measure);
        return latest ? { county: c, ...latest } : null;
      })
      .filter((x): x is { county: ContextCountyEntry; year: number; value: number } => x != null);

    countyData.forEach((d) => {
      if (latestYear == null || d.year > latestYear) latestYear = d.year;
    });

    // Color each county bar on a value-driven gradient (lighter = higher,
    // darker = lower). Min/max anchor the ramp to this card's data range
    // so the spread reads correctly even when one county dominates.
    const countyMin = countyData.reduce((m, d) => Math.min(m, d.value), Infinity);
    const countyMax = countyData.reduce((m, d) => Math.max(m, d.value), -Infinity);
    const countyRows: BarRow[] = countyData
      .sort((a, b) => b.value - a.value)
      .map((d) => ({
        key: d.county.geoid,
        label: d.county.name,
        value: d.value,
        fill: colorForValue(d.value, countyMin, countyMax),
        highlight: d.county.geoid === selectedCountyGeoid,
      }));

    // Places — sorted descending on the active variant. Highlight the
    // currently selected workplace ZIP.
    const placeData = env.places
      .map((p: ContextPlaceEntry) => {
        const latest = pickAnnualLatest(p.trend as unknown as CommerceTrend | undefined, measure);
        return latest ? { place: p, ...latest } : null;
      })
      .filter((x): x is { place: ContextPlaceEntry; year: number; value: number } => x != null);

    // Pie still uses the value gradient, but the Anchor places bar chart
    // gets a single neutral fill — sequential greys on closely-spaced
    // values were hard to discriminate. The selected anchor still
    // overrides to amber via the `highlight` channel.
    const placeRows: BarRow[] = placeData
      .sort((a, b) => b.value - a.value)
      .map((d) => ({
        key: d.place.zip,
        label: d.place.name,
        value: d.value,
        fill: 'var(--corridor-1)',
        highlight: d.place.zip === selectedZip,
      }));

    // Pie entries — start with the real anchor places, then append a
    // synthetic "Unincorporated {county}" slice for Garfield and Pitkin
    // representing the residual: county total − sum of anchors in that
    // county. Eagle is excluded (it has no anchors in our set, and
    // showing the entire county as a single "Unincorporated Eagle"
    // slice would dwarf everything else without adding insight).
    interface PieEntry {
      key: string;
      label: string;
      countyName: string;
      countyGeoid: string;
      value: number;
      zip?: string;
      isUnincorporated: boolean;
    }
    const pieEntries: PieEntry[] = placeData.map((d) => ({
      key: d.place.zip,
      label: d.place.name,
      countyName: d.place.countyName.replace(/ County$/, ''),
      countyGeoid: d.place.countyGeoid,
      value: d.value,
      zip: d.place.zip,
      isUnincorporated: false,
    }));

    const RESIDUAL_COUNTIES = ['08045', '08097'];
    for (const geoid of RESIDUAL_COUNTIES) {
      const county = env.counties.find((c) => c.geoid === geoid);
      if (!county) continue;
      const countyLatest = pickAnnualLatest(county.trend as unknown as CommerceTrend | undefined, measure);
      if (!countyLatest) continue;
      const anchorSum = placeData
        .filter((d) => d.place.countyGeoid === geoid)
        .reduce((sum, d) => sum + d.value, 0);
      const residual = countyLatest.value - anchorSum;
      // Skip if residual collapses to ≈0 or goes negative (data
      // mismatch — anchor sums shouldn't exceed the county total but
      // home-rule + state-collected sources are vintage-sensitive).
      if (residual <= countyLatest.value * 0.001) continue;
      const shortName = county.name.replace(/ County$/, '');
      pieEntries.push({
        key: `unincorp-${geoid}`,
        label: `Unincorporated ${shortName}`,
        countyName: shortName,
        countyGeoid: geoid,
        value: residual,
        isUnincorporated: true,
      });
    }

    // Filter to the active county scope (if any), then color on a
    // gradient computed against the visible value range.
    const pieSourceData = selectedCountyGeoid
      ? pieEntries.filter((e) => e.countyGeoid === selectedCountyGeoid)
      : pieEntries;
    const pieMin = pieSourceData.reduce((m, e) => Math.min(m, e.value), Infinity);
    const pieMax = pieSourceData.reduce((m, e) => Math.max(m, e.value), -Infinity);
    const pieSlices: PieSlice[] = pieSourceData
      .slice()
      .sort((a, b) => b.value - a.value)
      .map((e) => ({
        key: e.key,
        label: e.label,
        countyName: e.countyName,
        value: e.value,
        fill: colorForValue(e.value, pieMin, pieMax),
        highlight: e.zip != null && e.zip === selectedZip,
        interactive: !e.isUnincorporated,
      }));

    return { countyRows, placeRows, pieSlices, latestYear };
  }, [bundle, measure, selectedZip, selectedCountyGeoid]);

  const variantLabel =
    variant === 'gross' ? 'Gross Sales' : variant === 'retail' ? 'Retail Sales' : 'Net Taxable Sales';
  const yearTag = latestYear ? ` · ${latestYear}` : '';

  // Center label for the pie — describes what the visible total
  // represents. With unincorporated remainders included, the total is
  // the actual Garfield + Pitkin commerce (or just one of them when a
  // county is selected) rather than the sum of anchor places alone.
  const pieCenterLabel = selectedCountyGeoid
    ? (
        bundle?.commerce?.counties.find((c) => c.geoid === selectedCountyGeoid)?.name.replace(/ County$/, '') ?? 'TOTAL'
      ).toUpperCase()
    : 'GARFIELD + PITKIN';

  return (
    <div className="flex flex-col gap-3">
      <ChartCard
        title={`Counties · ${variantLabel}${yearTag}`}
        subtitle={
          handleCountyClick
            ? 'Click a county to scope the section'
            : 'Eagle / Garfield / Pitkin'
        }
      >
        <HorizontalBars
          rows={countyRows}
          formatValue={fmtCompactUSD}
          emptyLabel="no county data"
          ariaLabel="County comparison"
          onRowClick={handleCountyClick}
        />
      </ChartCard>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ChartCard
          title={`Anchor places · ${variantLabel}${yearTag}`}
          subtitle={
            handleRowClick
              ? 'Click a place to scope the dashboard to that anchor'
              : 'Bars tinted by containing county'
          }
        >
          <HorizontalBars
            rows={placeRows}
            formatValue={fmtCompactUSD}
            emptyLabel="no place data"
            ariaLabel="Anchor place comparison"
            onRowClick={handleRowClick}
          />
        </ChartCard>
        <ChartCard
          title={`Anchor place mix · ${variantLabel}${yearTag}`}
          subtitle={
            selectedCountyGeoid
              ? `Filtered to ${
                  bundle?.commerce?.counties.find((c) => c.geoid === selectedCountyGeoid)?.name.replace(/ County$/, '') ??
                  'selected county'
                } anchors${handleRowClick ? ' · click a slice to scope the dashboard' : ''}`
              : handleRowClick
              ? 'Click a slice to scope the dashboard'
              : 'Each place as % of the anchor total'
          }
        >
          <PiePlaces
            slices={pieSlices}
            formatValue={fmtCompactUSD}
            emptyLabel="no place data"
            ariaLabel="Anchor place mix"
            onSliceClick={handleRowClick}
            centerLabel={pieCenterLabel}
          />
        </ChartCard>
      </div>
    </div>
  );
}
