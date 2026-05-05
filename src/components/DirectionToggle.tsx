// East / West / All segmented control — independent of inbound/outbound.
// Up Valley / Down Valley render in a second row but share the same single-
// active-value tablist. Up Valley filters like East but only includes the 11
// anchor ZIPs as workplaces; Down Valley is an alias for West.
// Mirrors ModeToggle.tsx visually and structurally.

import type { DirectionFilter } from '../types/flow';

interface Props {
  value: DirectionFilter;
  onChange: (next: DirectionFilter) => void;
}

const ROW_1: ReadonlyArray<{ value: DirectionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'east', label: 'East' },
  { value: 'west', label: 'West' },
];

const ROW_2: ReadonlyArray<{ value: DirectionFilter; label: string }> = [
  { value: 'up-valley', label: 'Up Valley' },
  { value: 'down-valley', label: 'Down Valley' },
];

export function DirectionToggle({ value, onChange }: Props) {
  const renderButton = (opt: DirectionFilter, label: string) => {
    const active = value === opt;
    return (
      <button
        key={opt}
        role="tab"
        aria-selected={active}
        onClick={() => onChange(opt)}
        className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
        style={{
          background: active ? 'var(--accent)' : 'transparent',
          color: active ? '#1a1207' : 'var(--text)',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        Direction
      </span>
      <div
        role="tablist"
        aria-label="Geographic direction filter"
        className="flex flex-col gap-1 p-1 rounded-lg border"
        style={{
          background: 'rgba(255,255,255,0.03)',
          borderColor: 'var(--panel-border)',
        }}
      >
        <div className="flex gap-0">
          {ROW_1.map(({ value: opt, label }) => renderButton(opt, label))}
        </div>
        <div className="flex gap-0">
          {ROW_2.map(({ value: opt, label }) => renderButton(opt, label))}
        </div>
      </div>
    </div>
  );
}
