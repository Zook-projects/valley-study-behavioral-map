// ContextCards — six topic cards rendered together inside the bottom strip
// when Layer = Context.
//
// Each card carries one topic, with stacked geography rows:
//   - Per-anchor view  → selected place / containing county / Colorado
//   - Aggregate view   → 4 counties / Colorado (no place rows)
//
// No sparklines — text-only. Per the v2 spec the cards are a glanceable
// snapshot, not a full data exploration.

import { useId, useMemo, useState } from 'react';
import { area as d3Area, line as d3Line } from 'd3-shape';
import type {
  CommerceAnnualRow,
  CommerceMonthlyRow,
  CommerceTrend,
  ContextBundle,
  ContextLatest,
  ContextTopic,
  ContextEnvelope,
  ContextTrend,
} from '../types/context';
import { CONTEXT_TOPIC_LABELS } from '../types/context';
import { getPlaceWithRails } from '../lib/contextQueries';
import { fmtInt } from '../lib/format';
import type { OdSummaryFile, RacFile, WacFile } from '../types/lodes';

interface Props {
  bundle: ContextBundle | null;
  selectedZip: string | null;
  // LODES files used to render the Employment card (replaces the QCEW
  // context-bundle path). Required because LODES is the project's spine and
  // is always loaded alongside the bundle by CommuteView.
  racFile: RacFile;
  wacFile: WacFile;
  odSummary: OdSummaryFile;
  // Optional topic subset. When provided, only these topics render — used
  // by DashboardView to split the cards across Demographics / Commerce /
  // Housing sections. Defaults to VISIBLE_TOPICS so the Map view's
  // BottomCardStrip Demographics layer keeps showing all five.
  topics?: ContextTopic[];
  // Optional controlled-state hooks for the Commerce card. When provided,
  // the variant + cadence toggles are mirrored to the parent so other
  // surfaces (e.g. CommerceComparisons in DashboardView) can stay in sync.
  // Omit them and the card manages its own state, preserving the original
  // BottomCardStrip behavior.
  commerceVariant?: CommerceVariant;
  onCommerceVariantChange?: (v: CommerceVariant) => void;
  commerceCadence?: CommerceCadence;
  onCommerceCadenceChange?: (v: CommerceCadence) => void;
}

// Aggregate-view county order (fixed editorial sequence). Mesa County is
// intentionally omitted — see buildRows() comment for rationale.
const AGGREGATE_COUNTY_ORDER: string[] = [
  '08045', // Garfield
  '08037', // Eagle
  '08097', // Pitkin
];

// Topics rendered in the bottom strip — fixed editorial order, NOT the
// schema's CONTEXT_TOPICS order. 'tourism' is intentionally excluded:
// the lodging-tax surface needs a dedicated treatment (manual file drops
// for the LMD/STR series CDOR doesn't expose), so the placeholder card
// was pulled until that data lands.
const VISIBLE_TOPICS: ContextTopic[] = [
  'demographics',
  'employment',
  'commerce',
  'housing',
  'education',
];

// Housing-card variant — controls which Zillow ZHVI series the card
// surfaces as the headline. Defaults to "all" (Zillow's flagship "all
// homes" mid-tier sfrcondo series). SFR = single-family-only, Condo =
// condo/co-op-only — useful in Aspen / Snowmass where the mix is condo-
// heavy and the all-homes blend hides outsize SFR values.
type HousingVariant = 'all' | 'sfr' | 'condo';

const HOUSING_VARIANT_KEY: Record<HousingVariant, string> = {
  all: 'zhvi',
  sfr: 'zhviSfr',
  condo: 'zhviCondo',
};

const HOUSING_VARIANT_LABEL: Record<HousingVariant, string> = {
  all: 'Typical home value (average)',
  sfr: 'Typical home value (single family)',
  condo: 'Typical home value (condo/co-op)',
};

const HOUSING_VARIANT_CHIP_LABEL: Record<HousingVariant, string> = {
  all: 'Average',
  sfr: 'Single family',
  condo: 'Condo',
};

// Commerce-card variant — controls which CDOR column the card surfaces as
// the headline. Defaults to "gross" because Gross Sales is the broadest
// "business throughput" metric (typically what cities cite in EDC briefs);
// Retail Sales narrows to true retail-to-consumer; Net Taxable Sales is the
// state-tax base.
export type CommerceVariant = 'gross' | 'retail' | 'taxable';

// Commerce-card cadence — controls whether the inline sparkline shows the
// 10-point annual series (default) or the 120-point monthly series. Monthly
// surfaces seasonality (vital for tourism-driven economies); annual is the
// glanceable headline. Cadence only affects the sparkline; the headline
// number remains the latest complete year regardless.
export type CommerceCadence = 'annual' | 'monthly';

const COMMERCE_VARIANT_KEY: Record<CommerceVariant, string> = {
  gross: 'cdorGrossSales',
  retail: 'cdorRetailSales',
  taxable: 'cdorNetTaxableSales',
};

// Maps the variant to the field name on a CommerceAnnualRow / CommerceMonthlyRow
// (which use short keys: gross / retail / taxable, not the long CDOR
// column names). Used by the sparkline + comparison charts.
export const COMMERCE_VARIANT_TREND_KEY: Record<CommerceVariant, 'gross' | 'retail' | 'taxable'> = {
  gross: 'gross',
  retail: 'retail',
  taxable: 'taxable',
};

const COMMERCE_VARIANT_LABEL: Record<CommerceVariant, string> = {
  gross: 'Gross Sales',
  retail: 'Retail Sales',
  taxable: 'Net Taxable Sales',
};

const COMMERCE_VARIANT_CHIP_LABEL: Record<CommerceVariant, string> = {
  gross: 'Gross',
  retail: 'Retail',
  taxable: 'Taxable',
};

const COMMERCE_CADENCE_LABEL: Record<CommerceCadence, string> = {
  annual: 'Annual',
  monthly: 'Monthly',
};

// One headline metric per topic. Commerce is special: its key is variant-
// driven (see headlineKeyFor / headlineLabelFor below).
const HEADLINE_KEY: Record<ContextTopic, string> = {
  demographics: 'population',
  education: 'pctBachPlus',
  employment: 'qcewTotalEmp',
  housing: 'zhvi',
  commerce: 'cdorGrossSales', // default; overridden by variant in the card
  tourism: 'cdorLodgingTaxableSales',
};

const HEADLINE_LABEL: Record<ContextTopic, string> = {
  demographics: 'Population',
  education: 'Bachelor’s+ share',
  employment: 'Covered employment',
  housing: 'Typical home value',
  commerce: 'Gross Sales', // default label; variant override applied at render
  tourism: 'Lodging tax sales',
};

function headlineKeyFor(
  topic: ContextTopic,
  commerceVariant: CommerceVariant,
  housingVariant: HousingVariant,
): string {
  if (topic === 'commerce') return COMMERCE_VARIANT_KEY[commerceVariant];
  if (topic === 'housing') return HOUSING_VARIANT_KEY[housingVariant];
  return HEADLINE_KEY[topic];
}

function headlineLabelFor(
  topic: ContextTopic,
  commerceVariant: CommerceVariant,
  housingVariant: HousingVariant,
): string {
  if (topic === 'commerce') return COMMERCE_VARIANT_LABEL[commerceVariant];
  if (topic === 'housing') return HOUSING_VARIANT_LABEL[housingVariant];
  return HEADLINE_LABEL[topic];
}

/**
 * Geographic granularity tag appended to each card's headline label, so the
 * user can read off "what geography is this card's per-anchor row keyed to".
 *
 * Different sources publish at different levels:
 *   - Demographics / Education → Census ACS Place (or ZCTA for Old Snowmass)
 *   - Housing                  → Zillow ZIP-level
 *   - Commerce                 → CDOR retail-by-City
 *   - Employment               → LEHD LODES ZIP-keyed
 *
 * In the aggregate (no-anchor) view every card collapses to a regional
 * roll-up (state + Garfield/Eagle/Pitkin), so the suffix is always "region".
 */
function geographyLevelSuffix(topic: ContextTopic, isPerAnchor: boolean): string {
  if (!isPerAnchor) return 'region';
  switch (topic) {
    case 'demographics':
    case 'education':
    case 'commerce':
      return 'city';
    case 'employment':
    case 'housing':
      return 'ZIP';
    default:
      return 'region';
  }
}

const FORMATTERS: Record<ContextTopic, (v: number) => string> = {
  demographics: (v) => fmtInt(v),
  education: (v) => `${v.toFixed(1)}%`,
  employment: (v) => fmtInt(v),
  housing: (v) => `$${fmtInt(v)}`,
  commerce: (v) => `$${fmtInt(v)}`,
  tourism: (v) => `$${fmtInt(v)}`,
};

// Source identifier (matches the `id` field embedded in each topic JSON's
// sources[] array) that drives the headline metric for each topic.
const HEADLINE_SOURCE_ID: Record<ContextTopic, string> = {
  demographics: 'ACS5',
  education: 'ACS5_SUBJECT',
  employment: 'QCEW',
  housing: 'ZILLOW',
  commerce: 'CDOR_SALES',
  tourism: 'CDOR_LODGING',
};

// Compact display label for each source — keeps the source-line under the
// metric label scannable. Falls back to the agency string if a source id
// isn't recognized.
const SOURCE_LABELS: Record<string, string> = {
  ACS5: 'Census ACS 5-Year',
  ACS5_SUBJECT: 'Census ACS 5-Year (S1501)',
  QCEW: 'BLS QCEW',
  LAUS: 'BLS LAUS',
  BEA_REIS: 'BEA REIS',
  ZILLOW: 'Zillow ZHVI',
  HUD_FMR: 'HUD FMR',
  CBP: 'Census CBP',
  HOMERULE: 'Home-rule city reports',
  CDOR_SALES: 'CDOR Retail Reports',
  CDOR_LODGING: 'CDOR Lodging Tax',
  QCEW_TOURISM: 'BLS QCEW (NAICS 71/72)',
  BTS_T100: 'BTS T-100 Enplanements',
  RFTA_YIR: 'RFTA Year-in-Review',
};

function readNumber(latest: ContextLatest | null, key: string): number | null {
  if (!latest) return null;
  const v = latest[key];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

interface Row {
  label: string;
  value: string | null;
}

/**
 * Build the Employment card's three rows from LODES (RAC/WAC/OD), replacing
 * the BLS QCEW path. Per spec the card carries:
 *   1. Workplace jobs                 — total jobs whose worksite is in the ZIP (WAC)
 *   2. Resident jobs (in-ZIP)         — residents who live AND work in the ZIP (within-ZIP OD)
 *   3. Resident jobs (other ZIPs)     — residents who live in the ZIP but work elsewhere (outflow)
 *
 * Per-anchor view uses the selected ZIP's entry; aggregate view uses each
 * file's regional aggregate (sum across the 11 anchors).
 */
function buildEmploymentRows(
  _racFile: RacFile, // reserved for an upcoming "Total resident jobs" row
  wacFile: WacFile,
  odSummary: OdSummaryFile,
  selectedZip: string | null,
): { rows: Row[]; year: number } {
  let wacTotal: number | null = null;
  let withinTotal: number | null = null;
  let outflowTotal: number | null = null;
  let year = wacFile.latestYear;

  if (selectedZip) {
    const wac = wacFile.entries.find((e) => e.zip === selectedZip);
    const od = odSummary.entries.find((e) => e.zip === selectedZip);
    wacTotal = wac?.latest?.totalJobs ?? null;
    withinTotal = od?.withinZip.latest?.totalJobs ?? null;
    outflowTotal = od?.outflow.latest?.totalJobs ?? null;
    year = wac?.latestYear ?? od?.latestYear ?? year;
  } else {
    wacTotal = wacFile.aggregate.latest?.totalJobs ?? null;
    withinTotal = odSummary.aggregate.withinZip.latest?.totalJobs ?? null;
    outflowTotal = odSummary.aggregate.outflow.latest?.totalJobs ?? null;
    year = wacFile.aggregate.latestYear ?? year;
  }

  const fmt = (v: number | null) => (v == null ? null : fmtInt(v));
  return {
    year,
    rows: [
      { label: 'Workplace jobs', value: fmt(wacTotal) },
      { label: 'Resident jobs (in-ZIP)', value: fmt(withinTotal) },
      { label: 'Resident jobs (other ZIPs)', value: fmt(outflowTotal) },
    ],
  };
}

function buildRows(
  env: ContextEnvelope,
  topic: ContextTopic,
  selectedZip: string | null,
  bundle: ContextBundle,
  commerceVariant: CommerceVariant,
  housingVariant: HousingVariant,
): Row[] {
  const key = headlineKeyFor(topic, commerceVariant, housingVariant);
  const fmt = FORMATTERS[topic];

  // Helper to format a single value with the topic's formatter, or fall
  // back to a dimmed em-dash placeholder.
  const fmtRow = (label: string, latest: ContextLatest | null): Row => {
    const v = readNumber(latest, key);
    return { label, value: v == null ? null : fmt(v) };
  };

  if (selectedZip) {
    const { place, county, state } = getPlaceWithRails(bundle, topic, selectedZip);
    const rows: Row[] = [];
    if (place) {
      // Commerce-only: append "(X% of <County>)" to the place row when the
      // shareOfCounty precompute is available. Other topics fall through to
      // the plain row.
      let placeLabel = place.name;
      if (topic === 'commerce' && place.shareOfCounty?.latest && county) {
        const measure = COMMERCE_VARIANT_TREND_KEY[commerceVariant];
        const share = place.shareOfCounty.latest[measure];
        if (typeof share === 'number' && isFinite(share)) {
          placeLabel = `${place.name} (${(share * 100).toFixed(0)}% of ${county.name.replace(/ County$/, '')})`;
        }
      }
      rows.push(fmtRow(placeLabel, place.latest));
    }
    if (county) rows.push(fmtRow(county.name, county.latest));
    if (state) rows.push(fmtRow(state.name, state.latest));
    return rows;
  }

  // Aggregate view: counties (in fixed editorial order) followed by state.
  // Mesa County is intentionally hidden — it sits at the western edge of the
  // study area (De Beque only) and reads as outlier context that distracts
  // from the core Roaring Fork picture.
  const rows: Row[] = [];
  for (const fips of AGGREGATE_COUNTY_ORDER) {
    const c = env.counties.find((x) => x.geoid === fips);
    if (c) rows.push(fmtRow(c.name, c.latest));
  }
  if (env.state) rows.push(fmtRow(env.state.name, env.state.latest));
  return rows;
}

function VariantToggle<V extends string>({
  value,
  onChange,
  options,
  labels,
  ariaLabel,
}: {
  value: V;
  onChange: (v: V) => void;
  options: readonly V[];
  labels: Record<V, string>;
  ariaLabel: string;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 mt-1.5" role="group" aria-label={ariaLabel}>
      {options.map((v) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={active}
            className="rounded-sm px-1.5 py-[2px] text-[9px] tnum transition-colors"
            style={{
              color: active ? 'var(--accent)' : 'var(--text-dim)',
              background: active ? 'rgba(245, 158, 11, 0.16)' : 'transparent',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--panel-border)'}`,
            }}
          >
            {labels[v]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compact sparkline scoped to the Commerce card. Reads either the annual
 * (10 points, 2016–latest) or monthly (~120 points) series from a
 * CommerceTrend and projects the active variant (gross / retail / taxable)
 * onto a fixed 200×40 SVG. Stretches horizontally to fill its container
 * (preserveAspectRatio="none"). Latest-value dot rendered as a separately
 * positioned HTML element so it stays a perfect circle.
 */
const SPARK_VB_W = 200;
const SPARK_VB_H = 40;

function CommerceSparkline({
  trend,
  variant,
  cadence,
  ariaLabel,
}: {
  trend: CommerceTrend | undefined;
  variant: CommerceVariant;
  cadence: CommerceCadence;
  ariaLabel: string;
}) {
  const gradId = useId();
  const measure = COMMERCE_VARIANT_TREND_KEY[variant];

  const geometry = useMemo(() => {
    if (!trend) return null;
    type Pt = { x: number; y: number };
    const rows = cadence === 'annual' ? trend.annual : trend.monthly;
    if (!rows || rows.length < 2) return null;

    // Annual: x = year. Monthly: x = year * 12 + month so the series is
    // ordered and evenly spaced on the time axis.
    const points: Pt[] = rows.map((r) => {
      const yr = (r as CommerceAnnualRow).year;
      const mo = (r as CommerceMonthlyRow).month;
      const x = cadence === 'monthly' ? yr * 12 + (mo ?? 0) : yr;
      const y = (r as CommerceAnnualRow | CommerceMonthlyRow)[measure];
      return { x, y };
    });

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys, 0);
    const yMax = Math.max(...ys);
    const xSpan = xMax - xMin || 1;
    const ySpan = yMax - yMin || 1;
    const sx = (x: number) => ((x - xMin) / xSpan) * (SPARK_VB_W - 4) + 2;
    const sy = (y: number) =>
      SPARK_VB_H - 4 - ((y - yMin) / ySpan) * (SPARK_VB_H - 8);
    const linePath =
      d3Line<Pt>()
        .x((d) => sx(d.x))
        .y((d) => sy(d.y))(points) ?? '';
    const areaPath =
      d3Area<Pt>()
        .x((d) => sx(d.x))
        .y0(SPARK_VB_H)
        .y1((d) => sy(d.y))(points) ?? '';
    const last = points[points.length - 1];
    const latestRow = rows[rows.length - 1];
    const yearLabel = (latestRow as CommerceAnnualRow).year;
    return {
      linePath,
      areaPath,
      lastX: sx(last.x),
      lastY: sy(last.y),
      lastValue: last.y,
      yearLabel,
    };
  }, [trend, cadence, measure]);

  if (!geometry) return null;

  return (
    <div className="relative w-full" style={{ height: SPARK_VB_H }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SPARK_VB_W} ${SPARK_VB_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        style={{ display: 'block' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geometry.areaPath} fill={`url(#${gradId})`} />
        <path
          d={geometry.linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="absolute pointer-events-none rounded-full"
        style={{
          width: 4,
          height: 4,
          background: 'var(--accent)',
          left: `calc(${(geometry.lastX / SPARK_VB_W) * 100}% - 2px)`,
          top: `calc(${(geometry.lastY / SPARK_VB_H) * 100}% - 2px)`,
        }}
      />
    </div>
  );
}

function TopicCard({
  topic,
  headlineLabel,
  rows,
  sourceLine,
  variantToggle,
  cadenceToggle,
  sparkline,
  stretch = false,
}: {
  topic: ContextTopic;
  headlineLabel: string;
  rows: Row[];
  sourceLine: string | null;
  variantToggle?: React.ReactNode;
  // Optional Annual/Monthly toggle, rendered next to the variant toggle.
  // Used by Commerce; other topics omit.
  cadenceToggle?: React.ReactNode;
  // Optional inline trend chart rendered below the data rows. Used by
  // Commerce; other topics omit.
  sparkline?: React.ReactNode;
  // When true the card flex-grows to fill available width (Demographics
  // layer fills the strip on wide screens); when false it stays at the
  // fixed 240px width used by the LEHD-side card layout.
  stretch?: boolean;
}) {
  const allEmpty = rows.every((r) => r.value == null);
  return (
    <div
      className={
        stretch
          ? 'glass rounded-md p-3 flex flex-col gap-2'
          : 'glass rounded-md p-3 shrink-0 flex flex-col gap-2'
      }
      style={
        stretch
          ? { flex: '1 1 0', minWidth: 150, minHeight: 110 }
          : { width: 240, minHeight: 110 }
      }
    >
      <div>
        <div
          className="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          {CONTEXT_TOPIC_LABELS[topic]}
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-h)' }}>
          {headlineLabel}
        </div>
        {sourceLine && (
          <div
            className="text-[9px] mt-0.5"
            style={{ color: 'var(--text-dim)' }}
          >
            {sourceLine}
          </div>
        )}
        {(variantToggle || cadenceToggle) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {variantToggle}
            {cadenceToggle}
          </div>
        )}
      </div>
      {allEmpty ? (
        <div
          className="text-[11px] mt-1"
          style={{ color: 'var(--text-dim)' }}
        >
          no data published
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5 mt-0.5">
          {rows.map((r) => (
            <li
              key={r.label}
              className="flex items-baseline justify-between gap-2"
            >
              <span
                className="text-[11px] truncate"
                style={{ color: 'var(--text-dim)' }}
                title={r.label}
              >
                {r.label}
              </span>
              <span
                className="text-[12px] tnum"
                style={{
                  color: r.value ? 'var(--text-h)' : 'var(--text-dim)',
                }}
              >
                {r.value ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {sparkline && <div className="mt-1">{sparkline}</div>}
    </div>
  );
}

/**
 * Latest year present in the headline-metric trend across any geography in
 * the envelope. This reflects the actual freshest data point — e.g. Zillow
 * ZHVI's monthly tail extends past the ACS vintage end, so housing's
 * source-line date can correctly read 2025 or 2026 rather than 2024.
 */
function latestHeadlineYear(
  env: ContextEnvelope,
  topic: ContextTopic,
  commerceVariant: CommerceVariant,
  housingVariant: HousingVariant,
): number | null {
  let maxYear: number | null = null;

  // Commerce uses the new structured trend shape: { annual: [...], monthly: [...] }
  // — a single multi-measure series rather than per-metric arrays. Grab the
  // last complete annual year (which is also what `latest` reflects).
  if (topic === 'commerce') {
    const visitCommerce = (trend: ContextTrend | undefined) => {
      const annual = (trend as CommerceTrend | undefined)?.annual;
      if (!annual || annual.length === 0) return;
      const last = annual[annual.length - 1].year;
      if (maxYear === null || last > maxYear) maxYear = last;
    };
    if (env.state?.trend) visitCommerce(env.state.trend);
    for (const c of env.counties) visitCommerce(c.trend);
    for (const p of env.places) visitCommerce(p.trend);
    return maxYear;
  }

  const headlineKey = headlineKeyFor(topic, commerceVariant, housingVariant);
  const visit = (trend: ContextTrend | undefined) => {
    const series = (trend as Record<string, { year: number; value: number | null }[]> | undefined)?.[
      headlineKey
    ];
    if (!series || series.length === 0) return;
    const last = series[series.length - 1].year;
    if (maxYear === null || last > maxYear) maxYear = last;
  };
  if (env.state?.trend) visit(env.state.trend);
  for (const c of env.counties) visit(c.trend);
  for (const p of env.places) visit(p.trend);
  return maxYear;
}

function topicSourceLine(
  env: ContextEnvelope,
  topic: ContextTopic,
  commerceVariant: CommerceVariant,
  housingVariant: HousingVariant,
): string | null {
  const wantedId = HEADLINE_SOURCE_ID[topic];
  const src = env.sources.find((s) => s.id === wantedId) ?? env.sources[0];
  if (!src) return null;
  const label = SOURCE_LABELS[src.id] ?? src.agency;
  // Prefer the actual latest-data-point year derived from the trend; fall
  // back to the topic's vintage end, then the lastPulled date.
  const headlineYear = latestHeadlineYear(env, topic, commerceVariant, housingVariant);
  const fallbackYear = env.vintageRange?.end;
  const date =
    headlineYear ?? (fallbackYear && fallbackYear > 0 ? fallbackYear : src.lastPulled);
  return `${label} · ${date}`;
}

export function ContextCards({
  bundle,
  selectedZip,
  racFile,
  wacFile,
  odSummary,
  topics,
  commerceVariant: commerceVariantProp,
  onCommerceVariantChange,
  commerceCadence: commerceCadenceProp,
  onCommerceCadenceChange,
}: Props) {
  // Per-card variant state. When the parent passes a controlled value (used
  // by DashboardView so the Commerce card and the comparison charts share a
  // toggle), defer to it; otherwise keep self-managed state for legacy call
  // sites. Defaults follow the v2 spec:
  //   Commerce → Gross Sales (broadest "business throughput")
  //   Housing  → All homes (Zillow's flagship sfrcondo mid-tier series)
  const [commerceVariantLocal, setCommerceVariantLocal] = useState<CommerceVariant>('gross');
  const [commerceCadenceLocal, setCommerceCadenceLocal] = useState<CommerceCadence>('annual');
  const [housingVariant, setHousingVariant] = useState<HousingVariant>('all');
  const commerceVariant = commerceVariantProp ?? commerceVariantLocal;
  const setCommerceVariant = (v: CommerceVariant) => {
    if (onCommerceVariantChange) onCommerceVariantChange(v);
    if (commerceVariantProp === undefined) setCommerceVariantLocal(v);
  };
  const commerceCadence = commerceCadenceProp ?? commerceCadenceLocal;
  const setCommerceCadence = (v: CommerceCadence) => {
    if (onCommerceCadenceChange) onCommerceCadenceChange(v);
    if (commerceCadenceProp === undefined) setCommerceCadenceLocal(v);
  };

  if (!bundle) {
    return (
      <div className="text-[12px] px-3 py-2" style={{ color: 'var(--text-dim)' }}>
        Loading context…
      </div>
    );
  }
  const renderTopics = topics ?? VISIBLE_TOPICS;
  return (
    <>
      {renderTopics.map((topic) => {
        // Employment card pulls from LODES (RAC/WAC/OD) instead of the
        // BLS QCEW path. Three rows × one geography (selected ZIP or
        // regional aggregate) — explicitly different shape from the other
        // cards because LODES is keyed by ZIP, not by county/state.
        const isPerAnchor = selectedZip != null;
        const geoSuffix = geographyLevelSuffix(topic, isPerAnchor);

        if (topic === 'employment') {
          const { rows, year } = buildEmploymentRows(racFile, wacFile, odSummary, selectedZip);
          return (
            <TopicCard
              key={topic}
              topic={topic}
              headlineLabel={`Workforce flows · ${geoSuffix}`}
              rows={rows}
              sourceLine={`U.S. Census LEHD LODES · ${year}`}
              stretch
            />
          );
        }
        const env = bundle[topic];
        const rows = buildRows(env, topic, selectedZip, bundle, commerceVariant, housingVariant);
        const sourceLine = topicSourceLine(env, topic, commerceVariant, housingVariant);
        const baseHeadlineLabel = headlineLabelFor(topic, commerceVariant, housingVariant);
        const headlineLabel = `${baseHeadlineLabel} · ${geoSuffix}`;
        let variantToggle: React.ReactNode | undefined;
        let cadenceToggle: React.ReactNode | undefined;
        let sparkline: React.ReactNode | undefined;
        if (topic === 'commerce') {
          variantToggle = (
            <VariantToggle<CommerceVariant>
              value={commerceVariant}
              onChange={setCommerceVariant}
              options={['gross', 'retail', 'taxable']}
              labels={COMMERCE_VARIANT_CHIP_LABEL}
              ariaLabel="CDOR sales metric"
            />
          );
          cadenceToggle = (
            <VariantToggle<CommerceCadence>
              value={commerceCadence}
              onChange={setCommerceCadence}
              options={['annual', 'monthly']}
              labels={COMMERCE_CADENCE_LABEL}
              ariaLabel="Trend cadence"
            />
          );
          // Pull the sparkline source: place trend when a workplace ZIP is
          // selected, otherwise fall back to the containing county for the
          // selected place; in aggregate mode use Garfield (the central
          // county for the study area) so the card always shows a series.
          let sparkTrend: CommerceTrend | undefined;
          let sparkLabel = 'Colorado';
          if (selectedZip) {
            const { place, county } = getPlaceWithRails(bundle, 'commerce', selectedZip);
            const t = (place?.trend ?? county?.trend) as CommerceTrend | undefined;
            if (t && (t.annual?.length ?? 0) > 0) {
              sparkTrend = t;
              sparkLabel = place?.name ?? county?.name ?? sparkLabel;
            }
          }
          if (!sparkTrend) {
            const garfield = env.counties.find((c) => c.geoid === '08045');
            sparkTrend = garfield?.trend as CommerceTrend | undefined;
            sparkLabel = garfield?.name ?? sparkLabel;
          }
          sparkline = sparkTrend ? (
            <CommerceSparkline
              trend={sparkTrend}
              variant={commerceVariant}
              cadence={commerceCadence}
              ariaLabel={`${COMMERCE_VARIANT_LABEL[commerceVariant]} trend, ${sparkLabel}, ${commerceCadence}`}
            />
          ) : undefined;
        } else if (topic === 'housing') {
          variantToggle = (
            <VariantToggle<HousingVariant>
              value={housingVariant}
              onChange={setHousingVariant}
              options={['all', 'sfr', 'condo']}
              labels={HOUSING_VARIANT_CHIP_LABEL}
              ariaLabel="Zillow ZHVI property type"
            />
          );
        }
        return (
          <TopicCard
            key={topic}
            topic={topic}
            headlineLabel={headlineLabel}
            rows={rows}
            sourceLine={sourceLine}
            variantToggle={variantToggle}
            cadenceToggle={cadenceToggle}
            sparkline={sparkline}
            stretch
          />
        );
      })}
    </>
  );
}
