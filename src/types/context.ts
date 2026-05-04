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
export type ContextTrend = Record<string, TrendPoint[]>;

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
  kind: 'place' | 'zcta';
  placeGeoid: string | null;
  countyGeoid: string;
  countyName: string;
  latest: ContextLatest | null;
  trend: ContextTrend;
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
