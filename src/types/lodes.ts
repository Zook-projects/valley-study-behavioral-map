// Shared types for the LODES card-strip data emitted by scripts/build-data.py.
// Wire format for public/data/{rac,wac,od-summary}.json. Trend series cover
// 2002–2023 (22 vintages); breakdown blocks are latest-year only.

export interface TrendPoint {
  year: number;
  value: number;
}

// Dimensions emitted as 22-point sparklines on RAC/WAC entries + aggregate.
// Race, ethnicity, education, sex carry latest-year only (no trend).
export type RacWacTrendDim =
  | 'totalJobs'
  | 'ageU29' | 'age30to54' | 'age55plus'
  | 'wageLow' | 'wageMid' | 'wageHigh'
  | 'naicsGoods' | 'naicsTradeTransUtil' | 'naicsAllOther';

// Dimensions emitted as 22-point sparklines on OD inflow/outflow + aggregate.
export type OdTrendDim = RacWacTrendDim;

export type RacWacTrend = Record<RacWacTrendDim, TrendPoint[]>;
export type OdTrend = Record<OdTrendDim, TrendPoint[]>;

// ---------------------------------------------------------------------------
// Latest-year breakdown blocks
// ---------------------------------------------------------------------------
export interface AgeBlock {
  u29: number;
  age30to54: number;
  age55plus: number;
}

export interface WageBlock {
  low: number;
  mid: number;
  high: number;
}

export interface Naics3Block {
  goods: number;
  tradeTransUtil: number;
  allOther: number;
}

export interface RaceBlock {
  white: number;
  black: number;
  amInd: number;
  asian: number;
  nhpi: number;
  twoOrMore: number;
}

export interface EthnicityBlock {
  notHispanic: number;
  hispanic: number;
}

export interface EducationBlock {
  lessHs: number;
  hs: number;
  someCol: number;
  bachPlus: number;
}

export interface SexBlock {
  male: number;
  female: number;
}

// Latest-year RAC/WAC breakdown — 9 dimensions, mirrors the bottom-card panels.
export interface RacWacLatest {
  totalJobs: number;
  age: AgeBlock;
  wage: WageBlock;
  naics3: Naics3Block;
  race: RaceBlock;
  ethnicity: EthnicityBlock;
  education: EducationBlock;
  sex: SexBlock;
}

// OD records carry only the dimensions LEHD publishes on OD pairs:
// totalJobs, age, wage, naics3.
export interface OdLatest {
  totalJobs: number;
  age: AgeBlock;
  wage: WageBlock;
  naics3: Naics3Block;
}

// ---------------------------------------------------------------------------
// Per-ZIP entries (rac.json / wac.json / od-summary.json)
// ---------------------------------------------------------------------------
export interface RacEntry {
  zip: string;
  place: string;
  latestYear: number;
  latest: RacWacLatest;
  trend: RacWacTrend;
}

export interface WacEntry extends RacEntry {}

export interface OdPartner {
  zip: string;
  place: string;
  workers: number;
  // Full ZIP set rolled into this partner row. Multi-ZIP places (e.g.,
  // Eagle 81631 + 81637, Grand Junction 81501 + 81504) carry every member
  // ZIP here so the UI can match a row's exact universe to a selectedPartner
  // payload of the same shape. Empty for the ALL_OTHER residual.
  zips: string[];
  // Year-by-year worker totals (2002–latest) for this partner→anchor (or
  // anchor→partner, on the outflow side) flow. Sums across all member ZIPs
  // at each year. Drives the partner-scoped sparkline rendered in the
  // Workforce Flows card when a partner is selected.
  trend: TrendPoint[];
}

export interface OdSummaryEntry {
  zip: string;
  place: string;
  latestYear: number;
  inflow: {
    latest: OdLatest | null;
    trend: OdTrend;
  };
  outflow: {
    latest: OdLatest | null;
    trend: OdTrend;
  };
  // Within-ZIP commuters (h_zip == w_zip) — workers who live AND work in this
  // ZIP. Excluded from inflow/outflow above so those reflect only cross-ZIP
  // commuters; surfaced separately here as a "live and work" metric.
  // Latest carries the full OdLatest shape so the within-ZIP card can
  // recompute under a segment filter; trend mirrors OdTrend so each per-bucket
  // sparkline can re-aggregate from the same per-year per-bucket series.
  withinZip: {
    latest: OdLatest | null;
    trend: OdTrend;
  };
  topPartners: {
    inflow: OdPartner[];
    outflow: OdPartner[];
  };
}

// ---------------------------------------------------------------------------
// Aggregate roll-ups — emitted alongside per-zip entries in the same JSON.
// ---------------------------------------------------------------------------
export interface RacWacAggregate {
  latestYear: number;
  latest: RacWacLatest | null;
  trend: RacWacTrend;
}

export interface OdAggregate {
  latestYear: number;
  inflow: {
    latest: OdLatest | null;
    trend: OdTrend;
  };
  outflow: {
    latest: OdLatest | null;
    trend: OdTrend;
  };
  withinZip: {
    latest: OdLatest | null;
    trend: OdTrend;
  };
}

// Wire-format envelopes — match the JSON shape emitted by build-data.py.
export interface RacFile {
  latestYear: number;
  aggregate: RacWacAggregate;
  entries: RacEntry[];
}

export interface WacFile {
  latestYear: number;
  aggregate: RacWacAggregate;
  entries: WacEntry[];
}

export interface OdSummaryFile {
  latestYear: number;
  aggregate: OdAggregate;
  entries: OdSummaryEntry[];
}
