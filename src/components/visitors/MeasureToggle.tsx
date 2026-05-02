// MeasureToggle — Visits / Visitors switch for the Placer view. Drives the
// active measure used by stroke widths, dot sizes, and headline numbers.

import type { VisitorMeasure } from '../../types/placer';

interface Props {
  measure: VisitorMeasure;
  onChange: (next: VisitorMeasure) => void;
}

const OPTS: Array<{ value: VisitorMeasure; label: string; sub: string }> = [
  { value: 'visits', label: 'Visits', sub: 'Total trips' },
  { value: 'visitors', label: 'Visitors', sub: 'Unique people' },
];

export function MeasureToggle({ measure, onChange }: Props) {
  return (
    <div className="space-y-1">
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={{ color: 'var(--text-dim)' }}
      >
        Measure
      </div>
      <div
        className="rounded-md p-1 flex gap-1 text-[11px]"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
        role="tablist"
        aria-label="Measure"
      >
        {OPTS.map((o) => {
          const active = measure === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(o.value)}
              className="flex-1 px-2 py-1 rounded transition-colors"
              style={{
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-h)',
                border: active
                  ? '1px solid var(--accent)'
                  : '1px solid transparent',
              }}
            >
              <div className="font-semibold">{o.label}</div>
              <div
                className="text-[9px] uppercase tracking-wider"
                style={{ color: active ? 'var(--accent)' : 'var(--text-dim)' }}
              >
                {o.sub}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
