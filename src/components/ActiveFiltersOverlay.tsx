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
  // Block-selection chip — visible whenever any blocks are selected. The
  // selection itself is owned upstream in CommuteView; this overlay only
  // surfaces the chip + clear affordance.
  selectedBlockCount: number;
  onClearSelectedBlocks: () => void;
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
    // The chip wraps an interactive Clear button; its presence/disappearance
    // is also worth announcing to assistive tech, so use aria-live="polite"
    // (announces additions without grabbing focus) instead of role="status"
    // (which would frame the whole chip as a status region containing a
    // button — confusing for screen readers).
    <div
      className="glass inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] pointer-events-auto"
      style={{
        color: 'var(--accent)',
        border: '1px solid var(--panel-border)',
      }}
      aria-live="polite"
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
  selectedBlockCount,
  onClearSelectedBlocks,
}: Props) {
  const directionActive = directionFilter !== 'all';
  const segmentActive = segmentFilter.axis !== 'all';
  const blockSelectionActive = selectedBlockCount > 0;
  if (!directionActive && !selectedPartner && !segmentActive && !blockSelectionActive) return null;

  const directionLabel =
    directionFilter === 'east' ? 'Eastbound only' :
    directionFilter === 'west' ? 'Westbound only' :
    directionFilter === 'up-valley' ? 'Up Valley only (anchor workplaces + eastern-I-70 residences)' :
    directionFilter === 'down-valley' ? 'Down Valley only (excludes eastern-I-70 → inner-RF commutes)' :
    'Filtered';

  const segmentBucketsLabel =
    segmentActive && segmentFilter.buckets.length > 0
      ? segmentFilter.buckets
          .map((b) => BUCKET_LABELS[b] ?? b)
          .join(' · ')
      : 'all buckets';

  return (
    <div className="absolute top-3 left-3 z-30 flex flex-col items-start gap-1.5 pointer-events-none">
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
      {blockSelectionActive && (
        <Chip
          label={`Selected: ${fmtInt(selectedBlockCount)} block${selectedBlockCount === 1 ? '' : 's'}`}
          onClear={onClearSelectedBlocks}
          ariaLabel="Clear selected blocks"
        />
      )}
    </div>
  );
}
