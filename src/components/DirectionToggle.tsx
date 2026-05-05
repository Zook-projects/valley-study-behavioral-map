// East / West / All segmented control — independent of inbound/outbound.
// Up Valley / Down Valley render in a second row aligned beneath East and
// West respectively (column under All is intentionally empty), but share the
// same single-active-value tablist. Up Valley filters like East but only
// includes the 11 anchor ZIPs as workplaces (with an additive eastern-I-70-
// residence path); Down Valley is an alias for West.
// Mirrors ModeToggle.tsx visually and structurally.

import type { DirectionFilter } from '../types/flow';

interface Props {
  value: DirectionFilter;
  onChange: (next: DirectionFilter) => void;
}

// Two rows, three columns. Row 2 column 1 is null on purpose so Up Valley
// lines up under East and Down Valley under West.
const GRID: ReadonlyArray<ReadonlyArray<{ value: DirectionFilter; label: string } | null>> = [
  [
    { value: 'all', label: 'All' },
    { value: 'east', label: 'East' },
    { value: 'west', label: 'West' },
  ],
  [
    null,
    { value: 'up-valley', label: 'Up Valley' },
    { value: 'down-valley', label: 'Down Valley' },
  ],
];

export function DirectionToggle({ value, onChange }: Props) {
  const panelStyle = {
    background: 'rgba(255,255,255,0.03)',
    borderColor: 'var(--panel-border)',
  };
  const renderButton = (cell: { value: DirectionFilter; label: string }) => {
    const active = value === cell.value;
    return (
      <button
        key={cell.value}
        role="tab"
        aria-selected={active}
        onClick={() => onChange(cell.value)}
        className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
        style={{
          background: active ? 'var(--accent)' : 'transparent',
          color: active ? '#1a1207' : 'var(--text)',
        }}
      >
        {cell.label}
      </button>
    );
  };
  // Two stacked bordered panels rather than one — so the panel background
  // doesn't extend under the empty cell beneath "All". Row 2 sits in a
  // 3-column ghost grid with its bordered wrapper spanning columns 2-3, so
  // Up Valley lines up under East and Down Valley under West.
  return (
    <div
      role="tablist"
      aria-label="Geographic direction filter"
      className="flex flex-col gap-1.5"
    >
      <span
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        Direction
      </span>
      <div className="flex flex-col gap-1">
        <div
          className="grid grid-cols-3 gap-1 p-1 rounded-lg border"
          style={panelStyle}
        >
          {GRID[0].map((cell) => (cell ? renderButton(cell) : null))}
        </div>
        {/* Row 2: 2-col bordered panel sized + offset so its buttons line up
            exactly with East / West above. Each row contributes 1px border +
            4px padding = 5px on each horizontal edge plus 4px between cells,
            so the row-2 wrapper needs width (2W+6)/3 and margin-left
            (W-6)/3 to share button widths with row 1. */}
        <div
          className="grid grid-cols-2 gap-1 p-1 rounded-lg border"
          style={{
            ...panelStyle,
            marginLeft: 'calc((100% - 6px) / 3)',
            width: 'calc((200% + 6px) / 3)',
          }}
        >
          {GRID[1].slice(1).map((cell) => (cell ? renderButton(cell) : null))}
        </div>
      </div>
    </div>
  );
}
