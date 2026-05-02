// Top-left map overlay surfacing the active direction + partner filters.
// Lives outside the stats panel so the user can see what's filtered while
// looking at the map; the inline chips that previously sat in StatsForZip
// and StatsAggregated were moved here per design feedback.

import type { DirectionFilter, SegmentFilter } from '../types/flow';
import { fmtInt } from '../lib/format';

interface Props {
  directionFilter: DirectionFilter;
  onClearDirection: () => void;
  selectedPartner: { place: string; zips: string[] } | null;
  onClearPartner: () => void;
  // Cross-ZIP flow counts used for the direction-filter chip's
  // "{numerator} of {denominator} flows shown" sub-label. Pre-computed
  // upstream so this component stays presentational.
  directionNumerator: number;
  directionDenominator: number;
  segmentFilter: SegmentFilter;
  onClearSegmentFilter: () => void;
}

const AXIS_LABELS: Record<SegmentFilter['axis'], string> = {
  all: 'All workers',
  age: 'Age',
  wage: 'Earnings',
  naics3: 'Industry',
};

const BUCKET_LABELS: Record<string, string> = {
  u29: 'Under 30',
  age30to54: '30–54',
  age55plus: '55+',
  low: '≤ $1,250/mo',
  mid: '$1,251–$3,333',
  high: '> $3,333/mo',
  goods: 'Goods',
  tradeTransUtil: 'Trade · Trans · Util',
  allOther: 'All Other Services',
};

function Chip({
  label,
  onClear,
  ariaLabel,
}: {
  label: string;
  onClear: () => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="glass inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] pointer-events-auto"
      style={{
        color: 'var(--accent)',
        border: '1px solid var(--panel-border)',
      }}
      role="status"
    >
      <span
        className="inline-block w-1 h-1 rounded-full"
        style={{ background: 'var(--accent)' }}
      />
      <span className="tnum">{label}</span>
      <button
        type="button"
        onClick={onClear}
        className="ml-1 underline-offset-2 hover:underline"
        aria-label={ariaLabel}
        style={{ color: 'var(--accent)' }}
      >
        clear
      </button>
    </div>
  );
}

export function ActiveFiltersOverlay({
  directionFilter,
  onClearDirection,
  selectedPartner,
  onClearPartner,
  directionNumerator,
  directionDenominator,
  segmentFilter,
  onClearSegmentFilter,
}: Props) {
  const directionActive = directionFilter !== 'all';
  const segmentActive = segmentFilter.axis !== 'all';
  if (!directionActive && !selectedPartner && !segmentActive) return null;

  const directionLabel =
    directionFilter === 'east' ? 'Eastbound only' : 'Westbound only';

  const segmentBucketsLabel =
    segmentActive && segmentFilter.buckets.length > 0
      ? segmentFilter.buckets
          .map((b) => BUCKET_LABELS[b] ?? b)
          .join(' · ')
      : 'all buckets';

  return (
    <div className="absolute top-20 left-4 z-30 flex flex-col items-start gap-1.5 pointer-events-none">
      {directionActive && (
        <Chip
          label={`Filtered: ${directionLabel} · ${fmtInt(directionNumerator)} of ${fmtInt(directionDenominator)} flows shown`}
          onClear={onClearDirection}
          ariaLabel="Clear direction filter"
        />
      )}
      {selectedPartner && (
        <Chip
          label={`Partner: ${selectedPartner.place}${
            selectedPartner.zips.length === 1
              ? ` · ${selectedPartner.zips[0]}`
              : ' · multiple'
          }`}
          onClear={onClearPartner}
          ariaLabel="Clear partner filter"
        />
      )}
      {segmentActive && (
        <Chip
          label={`Segment: ${AXIS_LABELS[segmentFilter.axis]} · ${segmentBucketsLabel}`}
          onClear={onClearSegmentFilter}
          ariaLabel="Clear segment filter"
        />
      )}
    </div>
  );
}
