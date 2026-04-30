// Excel export builders — Region / Workplace / Corridor.
//
// Per the approved plan at .claude/plans/splendid-purring-wirth.md:
//   - Region & Workplace exports IGNORE every user filter (mode, direction,
//     segment, partner). Both inbound and outbound dimensions are included.
//   - Corridor export RESPECTS mode + direction + partner / pass-through
//     selections but ignores the segment filter. The pinned corridor's
//     aggregation is recomputed against unfiltered-by-segment flows.
//
// The exporter never mutates input arrays — every flow array is iterated
// directly out of App state. Existing helpers from flowQueries.ts and
// corridors.ts do all the math; this module just shapes worksheets.

import * as XLSX from 'xlsx';
import type {
  CorridorFlowEntry,
  CorridorId,
  CorridorRecord,
  DirectionFilter,
  FlowRow,
  Mode,
  PassThroughFile,
  ZipMeta,
} from '../types/flow';
import type { OdSummaryFile, RacFile, WacFile } from '../types/lodes';
import {
  ANCHOR_ZIPS,
  computeAggregated,
  computeAnchorRankings,
  detailForNonAnchorOrigin,
  detailForZip,
  filterByDirection,
  filterForSelection,
  meanCommuteMiles,
  type DriveDistanceMap,
} from './flowQueries';
import { buildVisibleCorridorMap } from './corridors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify a place / corridor label for use in a filename. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** UTC date in YYYY-MM-DD form for filename embedding. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Mountain Time wall-clock for the "Export Generated" cell. */
function nowMt(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute} MT`;
}

/** Look up a place name; falls back to the ZIP itself. The dataset includes
 *  some ZCTAs the Census ZIP→city crosswalk has no name for — those rows
 *  carry an empty string in `place`, so we check for non-blank explicitly
 *  rather than trusting the bare nullish-coalesce. */
function placeFor(zips: ZipMeta[], zip: string): string {
  if (zip === 'ALL_OTHER') return 'Out of state / unmappable';
  const place = zips.find((z) => z.zip === zip)?.place;
  return place && place.trim() ? place : zip;
}

/** Set number format on a contiguous run of cells in a column.
 *  Cell addresses are 0-indexed (row, col). */
function applyFormat(
  sheet: XLSX.WorkSheet,
  startRow: number,
  endRow: number,
  col: number,
  fmt: string,
): void {
  for (let r = startRow; r <= endRow; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: col });
    const cell = sheet[addr];
    if (cell && typeof cell.v === 'number') cell.z = fmt;
  }
}

const FMT_INT = '#,##0';
const FMT_PCT = '0.0%';
const FMT_DEC1 = '0.0';

// Reusable column-width hint for sheets with mixed text + numbers.
const WIDE_COLS = (n: number, w = 18) => Array.from({ length: n }, () => ({ wch: w }));

// ---------------------------------------------------------------------------
// Demographics block builder — used by Region.Demographics and
// Workplace.Summary (Tables D + E). Returns the rows for the four named
// dimensions only (per resolved Decision: drop race/ethnicity/edu/sex).
// ---------------------------------------------------------------------------

interface DemographicsBlock {
  totalJobs: number;
  age: { u29: number; age30to54: number; age55plus: number };
  wage: { low: number; mid: number; high: number };
  naics3: { goods: number; tradeTransUtil: number; allOther: number };
}

interface DemographicsRow {
  dimension: string;
  bucket: string;
  value: number;
  share: number; // fraction; formatted as percent on the sheet
}

function demographicsRows(b: DemographicsBlock | null): DemographicsRow[] {
  if (!b || b.totalJobs <= 0) {
    return [
      { dimension: 'Total Jobs', bucket: '—', value: b?.totalJobs ?? 0, share: 1 },
    ];
  }
  const t = b.totalJobs;
  return [
    { dimension: 'Total Jobs', bucket: '—', value: t, share: 1 },
    { dimension: 'Age', bucket: 'Under 30', value: b.age.u29, share: b.age.u29 / t },
    { dimension: 'Age', bucket: '30–54', value: b.age.age30to54, share: b.age.age30to54 / t },
    { dimension: 'Age', bucket: '55+', value: b.age.age55plus, share: b.age.age55plus / t },
    { dimension: 'Earnings', bucket: '≤$1,250/mo', value: b.wage.low, share: b.wage.low / t },
    { dimension: 'Earnings', bucket: '$1,251–$3,333/mo', value: b.wage.mid, share: b.wage.mid / t },
    { dimension: 'Earnings', bucket: '>$3,333/mo', value: b.wage.high, share: b.wage.high / t },
    { dimension: 'Industry (NAICS-3)', bucket: 'Goods-producing', value: b.naics3.goods, share: b.naics3.goods / t },
    { dimension: 'Industry (NAICS-3)', bucket: 'Trade/Trans/Utilities', value: b.naics3.tradeTransUtil, share: b.naics3.tradeTransUtil / t },
    { dimension: 'Industry (NAICS-3)', bucket: 'All Other Services', value: b.naics3.allOther, share: b.naics3.allOther / t },
  ];
}

// ---------------------------------------------------------------------------
// Flow-row column schema (Inflow / Outflow / Corridor Flow sheets)
// ---------------------------------------------------------------------------

const FLOW_COLUMNS = [
  'Origin ZIP',
  'Origin Place',
  'Dest ZIP',
  'Dest Place',
  'Workers',
  '% of Total',
  'Year',
  'Source',
  'Age <30',
  'Age 30–54',
  'Age 55+',
  'Wage Low',
  'Wage Mid',
  'Wage High',
  'NAICS Goods',
  'NAICS TTU',
  'NAICS All Other',
  'Corridor Path',
];

function flowRowCells(
  f: FlowRow,
  totalForShare: number,
  zips: ZipMeta[],
): (string | number)[] {
  const seg = f.segments;
  return [
    f.originZip,
    f.originPlace || placeFor(zips, f.originZip),
    f.destZip,
    f.destPlace || placeFor(zips, f.destZip),
    f.workerCount,
    totalForShare > 0 ? f.workerCount / totalForShare : 0,
    f.year,
    f.source,
    seg ? seg.age.u29 : '',
    seg ? seg.age.age30to54 : '',
    seg ? seg.age.age55plus : '',
    seg ? seg.wage.low : '',
    seg ? seg.wage.mid : '',
    seg ? seg.wage.high : '',
    seg ? seg.naics3.goods : '',
    seg ? seg.naics3.tradeTransUtil : '',
    seg ? seg.naics3.allOther : '',
    f.corridorPath.join(' | '),
  ];
}

/** Apply formats to flow-row sheets. workerColIdx = Workers column (5),
 *  shareColIdx = % of Total column (6). */
function formatFlowSheet(sheet: XLSX.WorkSheet, headerRow: number, dataRows: number): void {
  const last = headerRow + dataRows;
  // Workers (col 4) + segment columns (cols 8-16) → integer.
  for (const c of [4, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    applyFormat(sheet, headerRow + 1, last, c, FMT_INT);
  }
  // % of Total (col 5) → percent.
  applyFormat(sheet, headerRow + 1, last, 5, FMT_PCT);
}

// ---------------------------------------------------------------------------
// Region export
// ---------------------------------------------------------------------------

interface RegionExportInput {
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  zips: ZipMeta[];
  driveDistance: DriveDistanceMap | null;
  racFile: RacFile | null;
  wacFile: WacFile | null;
  // Pre-computed top corridor (label + total) per mode — App.tsx already
  // derives these for the dashboard. Re-derive locally if not provided.
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
}

/** Top corridor by worker total under unfiltered flows for one mode. */
function topCorridorOf(
  corridorIndex: Map<CorridorId, CorridorRecord>,
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>,
  flows: FlowRow[],
  mode: Mode,
): { label: string; total: number } | null {
  const map = buildVisibleCorridorMap(corridorIndex, flowIndex, flows, mode);
  let best: { label: string; total: number } | null = null;
  for (const agg of map.values()) {
    if (!best || agg.total > best.total) {
      best = { label: agg.corridor.label, total: agg.total };
    }
  }
  return best;
}

export function exportRegion(input: RegionExportInput): void {
  const { flowsInbound, flowsOutbound, zips, driveDistance, racFile, wacFile, corridorIndex, flowIndex } = input;

  // -- Sheet 1: Summary ------------------------------------------------------
  const summary = computeAggregated(flowsInbound);
  const avgMiles = meanCommuteMiles(flowsInbound, zips, driveDistance ?? undefined);
  const topInbound = topCorridorOf(corridorIndex, flowIndex, flowsInbound, 'inbound');
  const topOutbound = topCorridorOf(corridorIndex, flowIndex, flowsOutbound, 'outbound');
  const rankings = computeAnchorRankings(flowsInbound, flowsOutbound, zips);
  const dataYear = wacFile?.latestYear ?? racFile?.latestYear ?? '';

  const summaryRows: (string | number)[][] = [
    ['Region Statistics — Roaring Fork & Colorado River Valley'],
    [],
    ['Metric', 'Value', 'Detail'],
    ['Total Workforce', summary.totalWorkers, 'working within the 11 workplace ZIP codes'],
    ['Cross-ZIP Commuters', summary.crossZipCommuters, `${(summary.crossZipShare * 100).toFixed(1)}% of mapped workforce commutes`],
    ['Cross-ZIP Share', summary.crossZipShare, ''],
    ['Average Commute Distance (mi)', avgMiles, driveDistance ? 'worker-weighted, road miles, cross-ZIP only' : 'worker-weighted, straight-line × 1.25, cross-ZIP only'],
    ['Top Inbound Corridor — Workers', topInbound?.total ?? 0, topInbound?.label ?? '—'],
    ['Top Outbound Corridor — Workers', topOutbound?.total ?? 0, topOutbound?.label ?? '—'],
    ['Top OD Pair — Workers', summary.topOutbound?.workerCount ?? 0, summary.topOutbound ? `${summary.topOutbound.originPlace} → ${summary.topOutbound.destPlace}` : '—'],
    ['Outside the 11 ZIP Codes (share)', summary.outsideAnchorsShare, 'inbound workforce with residence outside the 11 ZIP codes'],
    ['Outside Colorado (share)', summary.outsideStateShare, 'inbound workforce with out-of-state or unmappable residence'],
    ['Data Vintage (LODES year)', dataYear, 'from RAC/WAC latestYear'],
    ['Export Generated', nowMt(), 'all user filters ignored — defaults to inbounds + direction all'],
    [],
    ['Workplace ZIP Code Rankings (sorted by Outbound Commuters)'],
    [],
    ['Rank', 'ZIP', 'Place', 'Outbound Commuters', 'Outbound % of Residents', 'Inbound Commuters', 'Inbound % of Workforce', 'Within-ZIP', 'Local Share'],
  ];
  const sortedRankings = [...rankings].sort((a, b) => b.outboundCommuters - a.outboundCommuters);
  sortedRankings.forEach((r, idx) => {
    const outDenom = r.outboundCommuters + r.withinZip;
    const inDenom = r.inboundCommuters + r.withinZip;
    summaryRows.push([
      idx + 1,
      r.zip,
      r.place,
      r.outboundCommuters,
      outDenom > 0 ? r.outboundCommuters / outDenom : 0,
      r.inboundCommuters,
      inDenom > 0 ? r.inboundCommuters / inDenom : 0,
      r.withinZip,
      r.localShare,
    ]);
  });

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  // Region Statistics value column (col B = 1).
  applyFormat(summarySheet, 3, 3, 1, FMT_INT); // Total Workforce
  applyFormat(summarySheet, 4, 4, 1, FMT_INT); // Cross-ZIP Commuters
  applyFormat(summarySheet, 5, 5, 1, FMT_PCT); // Cross-ZIP Share
  applyFormat(summarySheet, 6, 6, 1, FMT_DEC1); // Avg distance
  applyFormat(summarySheet, 7, 7, 1, FMT_INT); // Top Inbound Corridor
  applyFormat(summarySheet, 8, 8, 1, FMT_INT); // Top Outbound Corridor
  applyFormat(summarySheet, 9, 9, 1, FMT_INT); // Top OD Pair
  applyFormat(summarySheet, 10, 10, 1, FMT_PCT); // Outside 11
  applyFormat(summarySheet, 11, 11, 1, FMT_PCT); // Outside CO
  // Rankings table starts at row index 18 (header) → data 19..(19+11-1=29).
  const rankHeaderRow = 18;
  const rankFirst = rankHeaderRow + 1;
  const rankLast = rankFirst + sortedRankings.length - 1;
  for (const c of [3, 5, 7]) applyFormat(summarySheet, rankFirst, rankLast, c, FMT_INT);
  for (const c of [4, 6, 8]) applyFormat(summarySheet, rankFirst, rankLast, c, FMT_PCT);
  applyFormat(summarySheet, rankFirst, rankLast, 7, FMT_INT); // Within-ZIP
  summarySheet['!cols'] = WIDE_COLS(9, 22);

  // -- Sheet 2: Demographics -------------------------------------------------
  const wacAgg = wacFile?.aggregate.latest ?? null;
  const racAgg = racFile?.aggregate.latest ?? null;
  const wacRows = demographicsRows(wacAgg);
  const racRows = demographicsRows(racAgg);
  const demoRows: (string | number)[][] = [
    ['Demographics (latest year, all 11 anchor ZIPs)'],
    [`Data vintage: LODES ${dataYear}`],
    [],
    ['Dimension', 'Bucket', 'WAC (Jobs in 11 anchors)', 'WAC Share', 'RAC (Residents of 11 anchors)', 'RAC Share'],
  ];
  for (let i = 0; i < wacRows.length; i++) {
    const w = wacRows[i];
    const r = racRows[i];
    demoRows.push([w.dimension, w.bucket, w.value, w.share, r.value, r.share]);
  }
  const demoSheet = XLSX.utils.aoa_to_sheet(demoRows);
  const demoHeader = 3;
  const demoLast = demoHeader + wacRows.length;
  applyFormat(demoSheet, demoHeader + 1, demoLast, 2, FMT_INT);
  applyFormat(demoSheet, demoHeader + 1, demoLast, 3, FMT_PCT);
  applyFormat(demoSheet, demoHeader + 1, demoLast, 4, FMT_INT);
  applyFormat(demoSheet, demoHeader + 1, demoLast, 5, FMT_PCT);
  demoSheet['!cols'] = [{ wch: 22 }, { wch: 22 }, { wch: 24 }, { wch: 14 }, { wch: 28 }, { wch: 14 }];

  // Build + download.
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(wb, demoSheet, 'Demographics');
  XLSX.writeFile(wb, `valley-region-export-${todayIso()}.xlsx`);
}

// ---------------------------------------------------------------------------
// Workplace export — anchor branch
// ---------------------------------------------------------------------------

interface WorkplaceExportInput {
  selectedZip: string;
  zips: ZipMeta[];
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  racFile: RacFile | null;
  wacFile: WacFile | null;
  odSummary: OdSummaryFile | null;
  passThrough: PassThroughFile | null;
  selectionKind: 'aggregate' | 'anchor' | 'non-anchor';
  nonAnchorBundle: { place: string; zips: string[] } | null;
}

/** Aggregate top-N rows from a directional detail.flows by place. */
function aggregateByPlace(
  flows: FlowRow[],
  side: 'origin' | 'dest',
): { place: string; zips: string[]; workerCount: number }[] {
  const map = new Map<string, { place: string; zips: string[]; workerCount: number }>();
  for (const f of flows) {
    const place = side === 'origin' ? f.originPlace : f.destPlace;
    const zip = side === 'origin' ? f.originZip : f.destZip;
    if (!place) continue;
    const existing = map.get(place);
    if (existing) {
      existing.workerCount += f.workerCount;
      if (!existing.zips.includes(zip)) existing.zips.push(zip);
    } else {
      map.set(place, { place, zips: [zip], workerCount: f.workerCount });
    }
  }
  const rows = Array.from(map.values());
  for (const r of rows) r.zips.sort();
  rows.sort((a, b) => b.workerCount - a.workerCount);
  return rows;
}

export function exportWorkplace(input: WorkplaceExportInput): void {
  if (input.selectionKind === 'non-anchor') {
    return exportWorkplaceNonAnchor(input);
  }
  exportWorkplaceAnchor(input);
}

function exportWorkplaceAnchor(input: WorkplaceExportInput): void {
  const { selectedZip, zips, flowsInbound, flowsOutbound, racFile, wacFile, odSummary, passThrough } = input;
  const meta = zips.find((z) => z.zip === selectedZip);
  if (!meta) return;

  // Always use unfiltered datasets — ignore mode/direction/segment/partner.
  const inbDetail = detailForZip(flowsInbound, meta, 'inbound');
  const outDetail = detailForZip(flowsOutbound, meta, 'outbound');

  // -- Sheet 1: Summary ------------------------------------------------------
  const inboundCross = inbDetail.total - inbDetail.selfFlow; // workers from elsewhere
  const outboundCross = outDetail.total - outDetail.selfFlow; // residents to elsewhere
  const liveAndWork = inbDetail.selfFlow; // identical from outbound side
  const totalWorkforceInZip = inbDetail.total; // jobs located here
  const totalResidentsEmployed = outDetail.total; // residents who hold a job somewhere

  const summaryRows: (string | number)[][] = [
    [`Workplace Data Export — ${meta.place} (${meta.zip})`],
    [`Export Generated: ${nowMt()} · all user filters ignored`],
    [],
    ['Headline Statistics'],
    [],
    ['Metric', 'Inbound (workers commuting INTO ZIP)', 'Outbound (residents commuting OUT)'],
    ['Cross-ZIP Total', inboundCross, outboundCross],
    ['Within-ZIP (live & work)', liveAndWork, liveAndWork],
    ['Universe Total', totalWorkforceInZip, totalResidentsEmployed],
    ['Cross-ZIP Share of Universe', totalWorkforceInZip > 0 ? inboundCross / totalWorkforceInZip : 0, totalResidentsEmployed > 0 ? outboundCross / totalResidentsEmployed : 0],
    [],
  ];

  // Table B — Top 10 origins (inbound)
  const topOrigins = aggregateByPlace(inbDetail.flows, 'origin');
  const otherOrigins = topOrigins.slice(10).reduce((acc, r) => acc + r.workerCount, 0) + inbDetail.allOther;
  summaryRows.push(['Top 10 Origins (Inbound — workers commuting INTO ZIP)']);
  summaryRows.push([]);
  summaryRows.push(['Rank', 'Place', 'ZIPs', 'Workers', '% of Inbound Universe']);
  topOrigins.slice(0, 10).forEach((r, i) =>
    summaryRows.push([i + 1, r.place, r.zips.join(' · '), r.workerCount, totalWorkforceInZip > 0 ? r.workerCount / totalWorkforceInZip : 0]),
  );
  if (liveAndWork > 0) summaryRows.push(['—', `Within-ZIP commute (${meta.place})`, meta.zip, liveAndWork, totalWorkforceInZip > 0 ? liveAndWork / totalWorkforceInZip : 0]);
  if (otherOrigins > 0) summaryRows.push(['—', 'All Other Locations (incl. ALL_OTHER residual)', '—', otherOrigins, totalWorkforceInZip > 0 ? otherOrigins / totalWorkforceInZip : 0]);
  summaryRows.push([]);

  // Table C — Top 10 destinations (outbound)
  const topDests = aggregateByPlace(outDetail.flows, 'dest');
  const otherDests = topDests.slice(10).reduce((acc, r) => acc + r.workerCount, 0) + outDetail.allOther;
  summaryRows.push(['Top 10 Destinations (Outbound — residents commuting OUT)']);
  summaryRows.push([]);
  summaryRows.push(['Rank', 'Place', 'ZIPs', 'Workers', '% of Outbound Universe']);
  topDests.slice(0, 10).forEach((r, i) =>
    summaryRows.push([i + 1, r.place, r.zips.join(' · '), r.workerCount, totalResidentsEmployed > 0 ? r.workerCount / totalResidentsEmployed : 0]),
  );
  if (liveAndWork > 0) summaryRows.push(['—', `Within-ZIP commute (${meta.place})`, meta.zip, liveAndWork, totalResidentsEmployed > 0 ? liveAndWork / totalResidentsEmployed : 0]);
  if (otherDests > 0) summaryRows.push(['—', 'All Other Locations (incl. ALL_OTHER residual)', '—', otherDests, totalResidentsEmployed > 0 ? otherDests / totalResidentsEmployed : 0]);
  summaryRows.push([]);

  // Table D — Workplace Metrics (WAC for this ZIP)
  const wacEntry = wacFile?.entries.find((e) => e.zip === meta.zip);
  summaryRows.push([`Workplace Metrics (WAC for ${meta.zip})`]);
  summaryRows.push([]);
  summaryRows.push(['Dimension', 'Bucket', 'Value', 'Share']);
  for (const r of demographicsRows(wacEntry?.latest ?? null)) {
    summaryRows.push([r.dimension, r.bucket, r.value, r.share]);
  }
  summaryRows.push([]);

  // Table E — Workforce Mix (RAC for this ZIP)
  const racEntry = racFile?.entries.find((e) => e.zip === meta.zip);
  summaryRows.push([`Workforce Mix (RAC for ${meta.zip})`]);
  summaryRows.push([]);
  summaryRows.push(['Dimension', 'Bucket', 'Value', 'Share']);
  for (const r of demographicsRows(racEntry?.latest ?? null)) {
    summaryRows.push([r.dimension, r.bucket, r.value, r.share]);
  }
  summaryRows.push([]);

  // Table F — Workforce Flows (OD aggregate)
  const odEntry = odSummary?.entries.find((e) => e.zip === meta.zip);
  const inflowLatest = odEntry?.inflow.latest ?? null;
  const outflowLatest = odEntry?.outflow.latest ?? null;
  const withinLatest = odEntry?.withinZip.latest ?? null;
  summaryRows.push([`Workforce Flows (OD aggregate for ${meta.zip})`]);
  summaryRows.push([]);
  summaryRows.push(['Dimension', 'Bucket', 'Inflow (workers from elsewhere)', 'Outflow (residents to elsewhere)', 'Within-ZIP (live & work)']);
  const buckets: Array<{ dim: string; b: string; pick: (x: { totalJobs: number; age: { u29: number; age30to54: number; age55plus: number }; wage: { low: number; mid: number; high: number }; naics3: { goods: number; tradeTransUtil: number; allOther: number } }) => number }> = [
    { dim: 'Total Jobs', b: '—', pick: (x) => x.totalJobs },
    { dim: 'Age', b: 'Under 30', pick: (x) => x.age.u29 },
    { dim: 'Age', b: '30–54', pick: (x) => x.age.age30to54 },
    { dim: 'Age', b: '55+', pick: (x) => x.age.age55plus },
    { dim: 'Earnings', b: '≤$1,250/mo', pick: (x) => x.wage.low },
    { dim: 'Earnings', b: '$1,251–$3,333/mo', pick: (x) => x.wage.mid },
    { dim: 'Earnings', b: '>$3,333/mo', pick: (x) => x.wage.high },
    { dim: 'Industry (NAICS-3)', b: 'Goods-producing', pick: (x) => x.naics3.goods },
    { dim: 'Industry (NAICS-3)', b: 'Trade/Trans/Utilities', pick: (x) => x.naics3.tradeTransUtil },
    { dim: 'Industry (NAICS-3)', b: 'All Other Services', pick: (x) => x.naics3.allOther },
  ];
  for (const row of buckets) {
    summaryRows.push([
      row.dim,
      row.b,
      inflowLatest ? row.pick(inflowLatest) : 0,
      outflowLatest ? row.pick(outflowLatest) : 0,
      withinLatest ? row.pick(withinLatest) : 0,
    ]);
  }

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  // Best-effort numeric formatting — walk the entire sheet and format anything
  // numeric in known columns. Cheaper than tracking exact row indices.
  const range = XLSX.utils.decode_range(summarySheet['!ref'] ?? 'A1');
  for (let r = 0; r <= range.e.r; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const cell = summarySheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell || typeof cell.v !== 'number') continue;
      // Heuristic: cells with values 0..1 in a "share" column get %, else integer.
      if (cell.v >= 0 && cell.v <= 1 && /share|%/i.test(String(summaryRows[r]?.[c - 1] ?? '') + String(summaryRows[r]?.[0] ?? ''))) {
        cell.z = FMT_PCT;
      }
    }
  }
  // Headline + ranking tables already use specific column positions — apply
  // explicit formats for the share columns we know about.
  applyFormat(summarySheet, 9, 9, 1, FMT_PCT); // Cross-ZIP share inbound
  applyFormat(summarySheet, 9, 9, 2, FMT_PCT); // Cross-ZIP share outbound
  applyFormat(summarySheet, 6, 8, 1, FMT_INT); // Inbound integer column
  applyFormat(summarySheet, 6, 8, 2, FMT_INT); // Outbound integer column
  summarySheet['!cols'] = [{ wch: 26 }, { wch: 30 }, { wch: 22 }, { wch: 22 }, { wch: 22 }];

  // -- Sheet 2: Inflow -------------------------------------------------------
  const inflowFlows = flowsInbound
    .filter((f) => f.destZip === meta.zip)
    .sort((a, b) => b.workerCount - a.workerCount);
  const inflowRows: (string | number)[][] = [FLOW_COLUMNS];
  for (const f of inflowFlows) inflowRows.push(flowRowCells(f, totalWorkforceInZip, zips));
  const inflowSheet = XLSX.utils.aoa_to_sheet(inflowRows);
  formatFlowSheet(inflowSheet, 0, inflowFlows.length);
  inflowSheet['!cols'] = WIDE_COLS(FLOW_COLUMNS.length, 14);

  // -- Sheet 3: Outflow ------------------------------------------------------
  const outflowFlows = flowsOutbound
    .filter((f) => f.originZip === meta.zip)
    .sort((a, b) => b.workerCount - a.workerCount);
  const outflowRows: (string | number)[][] = [FLOW_COLUMNS];
  for (const f of outflowFlows) outflowRows.push(flowRowCells(f, totalResidentsEmployed, zips));
  const outflowSheet = XLSX.utils.aoa_to_sheet(outflowRows);
  formatFlowSheet(outflowSheet, 0, outflowFlows.length);
  outflowSheet['!cols'] = WIDE_COLS(FLOW_COLUMNS.length, 14);

  // -- Sheet 4: Pass-Through -------------------------------------------------
  const ptHeader = ['Direction', 'Origin ZIP', 'Origin Place', 'Dest ZIP', 'Dest Place', 'Workers', 'Through-Anchor ZIP', 'Through-Anchor Place', 'Year'];
  const ptRows: (string | number)[][] = [ptHeader];
  const ptEntry = passThrough?.byAnchor[meta.zip] ?? null;
  if (ptEntry) {
    const inbLabel = 'inbound (workplace at other anchor)';
    const outLabel = 'outbound (residence at other anchor)';
    for (const p of ptEntry.inbound.pairs) {
      ptRows.push([
        inbLabel,
        p.originZip,
        placeFor(zips, p.originZip),
        p.destZip,
        placeFor(zips, p.destZip),
        p.workerCount,
        meta.zip,
        meta.place,
        passThrough?.year ?? '',
      ]);
    }
    if (ptEntry.inbound.residual > 0) {
      ptRows.push([inbLabel, '—', 'Residual (beyond top-N)', '—', '—', ptEntry.inbound.residual, meta.zip, meta.place, passThrough?.year ?? '']);
    }
    for (const p of ptEntry.outbound.pairs) {
      ptRows.push([
        outLabel,
        p.originZip,
        placeFor(zips, p.originZip),
        p.destZip,
        placeFor(zips, p.destZip),
        p.workerCount,
        meta.zip,
        meta.place,
        passThrough?.year ?? '',
      ]);
    }
    if (ptEntry.outbound.residual > 0) {
      ptRows.push([outLabel, '—', 'Residual (beyond top-N)', '—', '—', ptEntry.outbound.residual, meta.zip, meta.place, passThrough?.year ?? '']);
    }
  }
  const ptSheet = XLSX.utils.aoa_to_sheet(ptRows);
  applyFormat(ptSheet, 1, ptRows.length - 1, 5, FMT_INT);
  ptSheet['!cols'] = WIDE_COLS(ptHeader.length, 18);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(wb, inflowSheet, 'Inflow');
  XLSX.utils.book_append_sheet(wb, outflowSheet, 'Outflow');
  XLSX.utils.book_append_sheet(wb, ptSheet, 'Pass-Through');
  XLSX.writeFile(wb, `valley-workplace-${meta.zip}-${slug(meta.place)}-${todayIso()}.xlsx`);
}

function exportWorkplaceNonAnchor(input: WorkplaceExportInput): void {
  const { nonAnchorBundle, flowsInbound, zips } = input;
  if (!nonAnchorBundle) return;
  const detail = detailForNonAnchorOrigin(flowsInbound, nonAnchorBundle.zips);
  const headlineTotal = detail.total;

  const summaryRows: (string | number)[][] = [
    [`Workplace Data Export — ${nonAnchorBundle.place} (non-anchor residence)`],
    [`ZIPs in bundle: ${nonAnchorBundle.zips.join(' · ')}`],
    [`Export Generated: ${nowMt()} · all user filters ignored`],
    [],
    ['Note: This place sits outside the 11 LODES workplace anchors. Only inbound-to-anchor flows are available; WAC, RAC, and Pass-Through data do not apply.'],
    [],
    ['Headline'],
    [],
    ['Metric', 'Value', 'Detail'],
    [`Inbound to Anchor Workplaces`, headlineTotal, `${nonAnchorBundle.place} residents employed at the 11 anchor ZIPs`],
    ['Number of Anchor Destinations', detail.flows.length, ''],
    [],
    ['Top Anchor Destinations'],
    [],
    ['Rank', 'Place', 'ZIPs', 'Workers', '% of Bundle Total'],
  ];

  // Group destination flows by place so multi-ZIP anchors (e.g. Aspen 81611+81612) collapse.
  const grouped = aggregateByPlace(detail.flows, 'dest');
  grouped.forEach((r, i) =>
    summaryRows.push([
      i + 1,
      r.place,
      r.zips.join(' · '),
      r.workerCount,
      headlineTotal > 0 ? r.workerCount / headlineTotal : 0,
    ]),
  );

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  applyFormat(summarySheet, 9, 10, 1, FMT_INT);
  const rankFirst = 14;
  const rankLast = rankFirst + grouped.length - 1;
  applyFormat(summarySheet, rankFirst, rankLast, 3, FMT_INT);
  applyFormat(summarySheet, rankFirst, rankLast, 4, FMT_PCT);
  summarySheet['!cols'] = [{ wch: 8 }, { wch: 28 }, { wch: 24 }, { wch: 14 }, { wch: 18 }];

  // Inflow sheet — bundle's residents → anchors.
  const inflowFlows = flowsInbound
    .filter((f) => nonAnchorBundle.zips.includes(f.originZip) && ANCHOR_ZIPS.includes(f.destZip))
    .sort((a, b) => b.workerCount - a.workerCount);
  const inflowRows: (string | number)[][] = [FLOW_COLUMNS];
  for (const f of inflowFlows) inflowRows.push(flowRowCells(f, headlineTotal, zips));
  const inflowSheet = XLSX.utils.aoa_to_sheet(inflowRows);
  formatFlowSheet(inflowSheet, 0, inflowFlows.length);
  inflowSheet['!cols'] = WIDE_COLS(FLOW_COLUMNS.length, 14);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(wb, inflowSheet, 'Inflow');
  XLSX.writeFile(wb, `valley-workplace-${slug(nonAnchorBundle.place)}-${todayIso()}.xlsx`);
}

// ---------------------------------------------------------------------------
// Corridor export
// ---------------------------------------------------------------------------

interface CorridorExportInput {
  corridorId: CorridorId;
  corridorIndex: Map<CorridorId, CorridorRecord>;
  flowIndex: Map<CorridorId, CorridorFlowEntry[]>;
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  zips: ZipMeta[];
  mode: Mode;
  directionFilter: DirectionFilter;
  // Optional partner / pass-through filters that the export should respect.
  // Each carries the place's full ZIP set so multi-ZIP places filter cleanly.
  selectedPartner: { place: string; zips: string[] } | null;
  passThroughOrigin: { place: string; zips: string[] } | null;
  passThroughDest: { place: string; zips: string[] } | null;
  selectedZip: string | null;
  selectionKind: 'aggregate' | 'anchor' | 'non-anchor';
  nonAnchorBundle: { place: string; zips: string[] } | null;
}

export function exportCorridor(input: CorridorExportInput): void {
  const {
    corridorId,
    corridorIndex,
    flowIndex,
    flowsInbound,
    flowsOutbound,
    zips,
    mode,
    directionFilter,
    selectedPartner,
    passThroughOrigin,
    passThroughDest,
    selectedZip,
    selectionKind,
    nonAnchorBundle,
  } = input;

  const corridor = corridorIndex.get(corridorId);
  if (!corridor) return;

  // Reproduce App.tsx's visibleFlows pipeline MINUS applySegmentFilter:
  //   1. Pick mode dataset
  //   2. filterByDirection (direction filter respected)
  //   3. filterForSelection (selectedZip narrowing respected)
  //   4. Apply partner / pass-through cross-filter if active
  // The non-anchor branch keeps the aggregate inbound network like App.tsx.
  const baseInbound = filterByDirection(flowsInbound, zips, directionFilter);
  const baseOutbound = filterByDirection(flowsOutbound, zips, directionFilter);
  let visible: FlowRow[];
  if (selectionKind === 'non-anchor') {
    visible = baseInbound;
  } else {
    visible = filterForSelection(
      mode === 'inbound' ? baseInbound : baseOutbound,
      selectedZip,
      mode,
    );
  }

  // Partner narrowing — scope to the selected partner's ZIP set on the
  // partner-side endpoint (origin in inbound, dest in outbound).
  if (selectedPartner) {
    const set = new Set(selectedPartner.zips);
    visible = visible.filter((f) => (mode === 'inbound' ? set.has(f.originZip) : set.has(f.destZip)));
  } else if (passThroughOrigin && passThroughDest) {
    const oset = new Set(passThroughOrigin.zips);
    const dset = new Set(passThroughDest.zips);
    visible = visible.filter((f) => oset.has(f.originZip) && dset.has(f.destZip));
  }

  // Non-anchor bundle scopes the visible flows further when the user has
  // pinned a corridor while a non-anchor place is selected — match App.tsx's
  // off-corridor branching layer.
  if (selectionKind === 'non-anchor' && nonAnchorBundle) {
    const set = new Set(nonAnchorBundle.zips);
    visible = visible.filter((f) => set.has(f.originZip));
  }

  // Aggregate the corridor against the segment-filter-free visible set.
  const visMap = buildVisibleCorridorMap(corridorIndex, flowIndex, visible, mode);
  const agg = visMap.get(corridorId);

  // Worker counts for the Place tables. agg may be undefined when no flows
  // survive the filters; fall back to empty maps so the workbook still has
  // headers + a clear "0 OD pairs" indicator.
  const byOrigin = agg?.byOriginZip ?? new Map<string, number>();
  const byDest = agg?.byDestZip ?? new Map<string, number>();
  const total = agg?.total ?? 0;

  const summaryRows: (string | number)[][] = [
    ['Corridor Data Export'],
    [`Export Generated: ${nowMt()} · respects mode/direction/partner; ignores segment filter`],
    [],
    ['Field', 'Value'],
    ['Corridor ID', corridor.id],
    ['Corridor Label', corridor.label],
    ['Road Name', corridor.roadName],
    ['Length (mi)', corridor.lengthMeters / 1609.344],
    ['Mode (active view)', mode],
    ['Direction Filter', directionFilter],
    ['Partner Filter', selectedPartner ? `${selectedPartner.place} (${selectedPartner.zips.join(' · ')})` : '—'],
    ['Pass-Through Filter', passThroughOrigin && passThroughDest ? `${passThroughOrigin.place} → ${passThroughDest.place}` : '—'],
    ['Total Workers (visible flows)', total],
    ['Number of OD Pairs', agg?.flows.length ?? 0],
    [],
    ['Places of Residence (origins on this corridor)'],
    [],
    ['ZIP', 'Place', 'Workers', '% of Corridor Total'],
  ];
  const originRows = Array.from(byOrigin.entries()).sort((a, b) => b[1] - a[1]);
  for (const [zip, workers] of originRows) {
    summaryRows.push([zip, placeFor(zips, zip), workers, total > 0 ? workers / total : 0]);
  }
  summaryRows.push([]);
  summaryRows.push(['Places of Work (destinations on this corridor)']);
  summaryRows.push([]);
  summaryRows.push(['ZIP', 'Place', 'Workers', '% of Corridor Total']);
  const destRows = Array.from(byDest.entries()).sort((a, b) => b[1] - a[1]);
  for (const [zip, workers] of destRows) {
    summaryRows.push([zip, placeFor(zips, zip), workers, total > 0 ? workers / total : 0]);
  }

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  applyFormat(summarySheet, 7, 7, 1, FMT_DEC1); // Length (mi)
  applyFormat(summarySheet, 12, 13, 1, FMT_INT); // Total + OD Pairs
  // Origin / dest tables use cols 2 (workers) + 3 (% share). Walk all rows
  // and apply formats to numeric cells in those columns.
  const range = XLSX.utils.decode_range(summarySheet['!ref'] ?? 'A1');
  for (let r = 18; r <= range.e.r; r++) {
    const wCell = summarySheet[XLSX.utils.encode_cell({ r, c: 2 })];
    const pCell = summarySheet[XLSX.utils.encode_cell({ r, c: 3 })];
    if (wCell && typeof wCell.v === 'number') wCell.z = FMT_INT;
    if (pCell && typeof pCell.v === 'number') pCell.z = FMT_PCT;
  }
  summarySheet['!cols'] = [{ wch: 16 }, { wch: 32 }, { wch: 14 }, { wch: 18 }];

  // -- Sheet 2: Corridor Flow ------------------------------------------------
  // One row per FlowRow whose path includes this corridor (under active mode).
  const corridorFlows = visible
    .filter((f) => f.corridorPath.includes(corridorId))
    .sort((a, b) => b.workerCount - a.workerCount);
  const flowHeader = [...FLOW_COLUMNS, 'Mode'];
  const flowRows: (string | number)[][] = [flowHeader];
  for (const f of corridorFlows) flowRows.push([...flowRowCells(f, total, zips), mode]);
  const flowSheet = XLSX.utils.aoa_to_sheet(flowRows);
  formatFlowSheet(flowSheet, 0, corridorFlows.length);
  flowSheet['!cols'] = WIDE_COLS(flowHeader.length, 14);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(wb, flowSheet, 'Corridor Flow');
  XLSX.writeFile(wb, `valley-corridor-${slug(corridor.label)}-${mode}-${todayIso()}.xlsx`);
}
