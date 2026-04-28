// East / West / All segmented control — independent of inbound/outbound.
// Mirrors ModeToggle.tsx visually and structurally.

import type { DirectionFilter } from '../types/flow';

interface Props {
  value: DirectionFilter;
  onChange: (next: DirectionFilter) => void;
}

const OPTIONS: ReadonlyArray<{ value: DirectionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'east', label: 'East' },
  { value: 'west', label: 'West' },
];

export function DirectionToggle({ value, onChange }: Props) {
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
        className="flex p-1 rounded-lg border"
        style={{
          background: 'rgba(255,255,255,0.03)',
          borderColor: 'var(--panel-border)',
        }}
      >
        {OPTIONS.map(({ value: opt, label }) => {
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
        })}
      </div>
    </div>
  );
}
