// Top-left map overlay surfacing the active direction + partner filters.
// Lives outside the stats panel so the user can see what's filtered while
// looking at the map; the inline chips that previously sat in StatsForZip
// and StatsAggregated were moved here per design feedback.

import type { DirectionFilter } from '../types/flow';
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
}

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
}: Props) {
  const directionActive = directionFilter !== 'all';
  if (!directionActive && !selectedPartner) return null;

  const directionLabel =
    directionFilter === 'east' ? 'Eastbound only' : 'Westbound only';

  return (
    <div className="absolute top-4 left-4 z-30 flex flex-col items-start gap-1.5 pointer-events-none">
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
    </div>
  );
}
