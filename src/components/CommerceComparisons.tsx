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

import { useMemo } from 'react';
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
}

// Soft tint per containing county so place bars carry geographic context
// at a glance. Pulls from the same corridor palette used elsewhere in the
// app for consistency across views.
const COUNTY_TINT: Record<string, string> = {
  '08045': 'var(--corridor-1)', // Garfield
  '08097': 'var(--corridor-2)', // Pitkin
  '08037': 'var(--corridor-3)', // Eagle
  '08077': 'var(--corridor-4)', // Mesa
};

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
}: Props) {
  // Toggle helper: clicking the currently selected anchor clears the
  // filter; clicking any other anchor sets it. Mirrors how the rest of
  // the dashboard treats "click again to deselect."
  const handleRowClick = onSelectPlace
    ? (zip: string) => onSelectPlace(zip === selectedZip ? null : zip)
    : undefined;
  const measure = COMMERCE_VARIANT_TREND_KEY[variant];

  const { countyRows, placeRows, shareRows, latestYear } = useMemo(() => {
    if (!bundle) {
      return { countyRows: [], placeRows: [], shareRows: [], latestYear: null };
    }
    const env = bundle.commerce;
    if (!env) return { countyRows: [], placeRows: [], shareRows: [], latestYear: null };

    let latestYear: number | null = null;

    // Counties — sorted descending on the active variant.
    const countyData = env.counties
      .map((c: ContextCountyEntry) => {
        const latest = pickAnnualLatest(c.trend as unknown as CommerceTrend | undefined, measure);
        return latest ? { county: c, ...latest } : null;
      })
      .filter((x): x is { county: ContextCountyEntry; year: number; value: number } => x != null);

    countyData.forEach((d) => {
      if (latestYear == null || d.year > latestYear) latestYear = d.year;
    });

    const countyRows: BarRow[] = countyData
      .sort((a, b) => b.value - a.value)
      .map((d) => ({
        key: d.county.geoid,
        label: d.county.name,
        value: d.value,
        fill: COUNTY_TINT[d.county.geoid] ?? 'var(--corridor-1)',
      }));

    // Places — sorted descending on the active variant. Highlight the
    // currently selected workplace ZIP.
    const placeData = env.places
      .map((p: ContextPlaceEntry) => {
        const latest = pickAnnualLatest(p.trend as unknown as CommerceTrend | undefined, measure);
        return latest ? { place: p, ...latest } : null;
      })
      .filter((x): x is { place: ContextPlaceEntry; year: number; value: number } => x != null);

    const placeRows: BarRow[] = placeData
      .sort((a, b) => b.value - a.value)
      .map((d) => ({
        key: d.place.zip,
        label: d.place.name,
        value: d.value,
        fill: COUNTY_TINT[d.place.countyGeoid] ?? 'var(--corridor-1)',
        highlight: d.place.zip === selectedZip,
      }));

    // County-share — each anchor place's latest annual share of its county.
    // Sorted descending by share.
    const shareRows: BarRow[] = env.places
      .map((p: ContextPlaceEntry) => {
        const latest = p.shareOfCounty?.latest;
        if (!latest) return null;
        const v = latest[measure];
        if (typeof v !== 'number' || !isFinite(v)) return null;
        return {
          key: p.zip,
          label: `${p.name} → ${p.countyName.replace(/ County$/, '')}`,
          value: v * 100,
          fill: COUNTY_TINT[p.countyGeoid] ?? 'var(--corridor-1)',
          highlight: p.zip === selectedZip,
        } as BarRow;
      })
      .filter((x): x is BarRow => x != null)
      .sort((a, b) => b.value - a.value);

    return { countyRows, placeRows, shareRows, latestYear };
  }, [bundle, measure, selectedZip]);

  const variantLabel =
    variant === 'gross' ? 'Gross Sales' : variant === 'retail' ? 'Retail Sales' : 'Net Taxable Sales';
  const yearTag = latestYear ? ` · ${latestYear}` : '';

  return (
    <div className="flex flex-col gap-3">
      <ChartCard
        title={`Counties · ${variantLabel}${yearTag}`}
        subtitle="Eagle / Garfield / Mesa / Pitkin"
      >
        <HorizontalBars
          rows={countyRows}
          formatValue={fmtCompactUSD}
          emptyLabel="no county data"
          ariaLabel="County comparison"
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
          title={`Place share of county · ${variantLabel}${yearTag}`}
          subtitle={
            handleRowClick
              ? 'Click to scope the dashboard'
              : 'Each place as % of its containing county'
          }
        >
          <HorizontalBars
            rows={shareRows}
            formatValue={(v) => `${v.toFixed(1)}%`}
            emptyLabel="no share data"
            ariaLabel="Place share of containing county"
            axisMax={100}
            onRowClick={handleRowClick}
          />
        </ChartCard>
      </div>
    </div>
  );
}
