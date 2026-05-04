// ContextCards — six topic cards rendered together inside the bottom strip
// when Layer = Context.
//
// Each card carries one topic, with stacked geography rows:
//   - Per-anchor view  → selected place / containing county / Colorado
//   - Aggregate view   → 4 counties / Colorado (no place rows)
//
// No sparklines — text-only. Per the v2 spec the cards are a glanceable
// snapshot, not a full data exploration.

import { useState } from 'react';
import type {
  ContextBundle,
  ContextLatest,
  ContextTopic,
  ContextEnvelope,
  ContextTrend,
} from '../types/context';
import { CONTEXT_TOPICS, CONTEXT_TOPIC_LABELS } from '../types/context';
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
}

// Aggregate-view county order (fixed editorial sequence). Mesa County is
// intentionally omitted — see buildRows() comment for rationale.
const AGGREGATE_COUNTY_ORDER: string[] = [
  '08045', // Garfield
  '08037', // Eagle
  '08097', // Pitkin
];

// Topics rendered in the bottom strip. 'tourism' is intentionally excluded —
// the lodging-tax surface needs a dedicated treatment (manual file drops for
// the local LMD/STR series CDOR doesn't expose), so the placeholder card was
// pulled until that data lands.
const VISIBLE_TOPICS: ContextTopic[] = CONTEXT_TOPICS.filter((t) => t !== 'tourism');

// Commerce-card variant — controls which CDOR column the card surfaces as
// the headline. Defaults to "gross" because Gross Sales is the broadest
// "business throughput" metric (typically what cities cite in EDC briefs);
// Retail Sales narrows to true retail-to-consumer; Net Taxable Sales is the
// state-tax base.
type CommerceVariant = 'gross' | 'retail' | 'taxable';

const COMMERCE_VARIANT_KEY: Record<CommerceVariant, string> = {
  gross: 'cdorGrossSales',
  retail: 'cdorRetailSales',
  taxable: 'cdorNetTaxableSales',
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

function headlineKeyFor(topic: ContextTopic, commerceVariant: CommerceVariant): string {
  if (topic === 'commerce') return COMMERCE_VARIANT_KEY[commerceVariant];
  return HEADLINE_KEY[topic];
}

function headlineLabelFor(topic: ContextTopic, commerceVariant: CommerceVariant): string {
  if (topic === 'commerce') return COMMERCE_VARIANT_LABEL[commerceVariant];
  return HEADLINE_LABEL[topic];
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
): Row[] {
  const key = headlineKeyFor(topic, commerceVariant);
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
    if (place) rows.push(fmtRow(place.name, place.latest));
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

function VariantToggle({
  value,
  onChange,
}: {
  value: CommerceVariant;
  onChange: (v: CommerceVariant) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 mt-1.5" role="group" aria-label="CDOR sales metric">
      {(['gross', 'retail', 'taxable'] as CommerceVariant[]).map((v) => {
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
            {COMMERCE_VARIANT_CHIP_LABEL[v]}
          </button>
        );
      })}
    </div>
  );
}

function TopicCard({
  topic,
  headlineLabel,
  rows,
  sourceLine,
  variantToggle,
}: {
  topic: ContextTopic;
  headlineLabel: string;
  rows: Row[];
  sourceLine: string | null;
  variantToggle?: React.ReactNode;
}) {
  const allEmpty = rows.every((r) => r.value == null);
  return (
    <div
      className="glass rounded-md p-3 shrink-0 flex flex-col gap-2"
      style={{ width: 240, minHeight: 110 }}
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
        {variantToggle}
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
): number | null {
  const headlineKey = headlineKeyFor(topic, commerceVariant);
  let maxYear: number | null = null;
  const visit = (trend: ContextTrend | undefined) => {
    const series = trend?.[headlineKey];
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
): string | null {
  const wantedId = HEADLINE_SOURCE_ID[topic];
  const src = env.sources.find((s) => s.id === wantedId) ?? env.sources[0];
  if (!src) return null;
  const label = SOURCE_LABELS[src.id] ?? src.agency;
  // Prefer the actual latest-data-point year derived from the trend; fall
  // back to the topic's vintage end, then the lastPulled date.
  const headlineYear = latestHeadlineYear(env, topic, commerceVariant);
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
}: Props) {
  // Commerce-card variant — local state, not lifted. Defaults to "gross"
  // per the v2 spec (Gross Sales = broadest economic-throughput metric).
  const [commerceVariant, setCommerceVariant] = useState<CommerceVariant>('gross');

  if (!bundle) {
    return (
      <div className="text-[12px] px-3 py-2" style={{ color: 'var(--text-dim)' }}>
        Loading context…
      </div>
    );
  }
  return (
    <>
      {VISIBLE_TOPICS.map((topic) => {
        // Employment card pulls from LODES (RAC/WAC/OD) instead of the
        // BLS QCEW path. Three rows × one geography (selected ZIP or
        // regional aggregate) — explicitly different shape from the other
        // cards because LODES is keyed by ZIP, not by county/state.
        if (topic === 'employment') {
          const { rows, year } = buildEmploymentRows(racFile, wacFile, odSummary, selectedZip);
          return (
            <TopicCard
              key={topic}
              topic={topic}
              headlineLabel={selectedZip ? 'Workforce flows · ZIP' : 'Workforce flows · region'}
              rows={rows}
              sourceLine={`U.S. Census LEHD LODES · ${year}`}
            />
          );
        }
        const env = bundle[topic];
        const rows = buildRows(env, topic, selectedZip, bundle, commerceVariant);
        const sourceLine = topicSourceLine(env, topic, commerceVariant);
        const headlineLabel = headlineLabelFor(topic, commerceVariant);
        const variantToggle =
          topic === 'commerce' ? (
            <VariantToggle value={commerceVariant} onChange={setCommerceVariant} />
          ) : undefined;
        return (
          <TopicCard
            key={topic}
            topic={topic}
            headlineLabel={headlineLabel}
            rows={rows}
            sourceLine={sourceLine}
            variantToggle={variantToggle}
          />
        );
      })}
    </>
  );
}
