// Shared types for the regional-context dataset emitted by
// scripts/build-context.py. Wire format for public/data/context/*.json.
//
// Six topics, three geographic levels (state, counties, places). Every
// envelope shares the same shape; per-topic latest/trend keys vary.

export type ContextTopic =
  | 'demographics'
  | 'education'
  | 'employment'
  | 'housing'
  | 'commerce'
  | 'tourism';

export const CONTEXT_TOPICS: ContextTopic[] = [
  'demographics',
  'education',
  'employment',
  'housing',
  'commerce',
  'tourism',
];

export interface TrendPoint {
  year: number;
  value: number | null;
}

// Per-topic latest blocks are open dicts — each fetcher emits whatever keys
// the source publishes at that geographic level. The renderer treats unknown
// keys as opaque numerics; null means "source did not publish at this level".
export type ContextLatest = Record<string, number | string | null>;

// Generic trend container. Most topics emit `{ <metric>: TrendPoint[] }`,
// keyed by the same field names that appear in `latest`. The Commerce topic
// is the exception — it emits a structured `{ annual: [...], monthly: [...] }`
// shape (see CommerceTrend below); commerce-aware callers cast `trend` to
// CommerceTrend at the use site so the broader `Record<string, TrendPoint[]>`
// inference stays clean for every other topic.
export type ContextTrend = Record<string, TrendPoint[]>;

// Commerce-specific trend shape. Each row carries gross, retail, and
// taxable values together so the variant toggle (Gross / Retail / Taxable)
// can swap measures without re-fetching. Annual rows are emitted only for
// complete years (12 months reported); monthly rows include partial leading
// edges so the chart shows true cadence.
export interface CommerceAnnualRow {
  year: number;
  gross: number;
  retail: number;
  taxable: number;
}

export interface CommerceMonthlyRow {
  year: number;
  month: number;
  gross: number;
  retail: number;
  taxable: number;
}

export interface CommerceTrend {
  annual: CommerceAnnualRow[];
  monthly: CommerceMonthlyRow[];
}

// Place-level "share of containing county" precompute, emitted alongside
// `trend` on commerce place entries. Values are fractions in [0, 1] (or
// occasionally above 1 for regional retail hubs that pull cross-county
// shoppers — CDOR captures this by point-of-sale).
export interface CommerceShareRow {
  year: number;
  month?: number;
  gross: number | null;
  retail: number | null;
  taxable: number | null;
}

export interface CommerceShareOfCounty {
  latest: CommerceShareRow | null;
  annual: CommerceShareRow[];
  monthly: CommerceShareRow[];
}

export interface ContextSource {
  id: string;
  agency: string;
  dataset: string;
  endpoint: string;
  lastPulled: string; // ISO date
}

export interface ContextStateEntry {
  fips: string;
  name: string;
  latest: ContextLatest | null;
  trend: ContextTrend;
}

export interface ContextCountyEntry {
  fips: string; // 3-digit, e.g., "045"
  geoid: string; // full 5-digit, e.g., "08045"
  name: string;
  latest: ContextLatest | null;
  trend: ContextTrend;
}

export interface ContextPlaceEntry {
  zip: string;
  name: string;
  kind: 'place' | 'zcta' | 'national';
  placeGeoid: string | null;
  countyGeoid: string;
  countyName: string;
  latest: ContextLatest | null;
  trend: ContextTrend;
  // Commerce-specific extra. Present only on commerce place entries; other
  // topics omit this field. See CommerceShareOfCounty for shape.
  shareOfCounty?: CommerceShareOfCounty;
}

export interface ContextEnvelope {
  topic: ContextTopic;
  vintageRange: { start: number; end: number };
  sources: ContextSource[];
  state: ContextStateEntry | null;
  counties: ContextCountyEntry[];
  places: ContextPlaceEntry[];
}

// Convenience: the loaded files keyed by topic.
export type ContextBundle = Record<ContextTopic, ContextEnvelope>;

// Display labels for the UI tier-2 toggle.
export const CONTEXT_TOPIC_LABELS: Record<ContextTopic, string> = {
  demographics: 'Demographics',
  education: 'Education',
  employment: 'Employment',
  housing: 'Housing',
  commerce: 'Commerce',
  tourism: 'Tourism',
};
