// DatasetToggle — top-level switch between the commute (LEHD LODES) view and
// the visitor (Placer.ai) view. Lives in App.tsx as a floating chip pinned
// to the top-left of the viewport, above where each view's left rail starts.
//
// The two views are completely independent React subtrees — toggling here
// unmounts one and mounts the other. State within each view does not persist
// across the switch, by design (the two universes don't share selection /
// filter semantics).

import type { Dataset } from '../types/dataset';

interface Props {
  dataset: Dataset;
  onChange: (next: Dataset) => void;
}

const OPTIONS: Array<{ value: Dataset; label: string; sub: string }> = [
  { value: 'commute', label: 'Commute Flows', sub: 'LEHD LODES · 2002–2023' },
  { value: 'visitors', label: 'Visitor Origins', sub: 'Placer.ai · 2025' },
];

export function DatasetToggle({ dataset, onChange }: Props) {
  return (
    <div
      className="glass rounded-md p-1 flex gap-1 text-[11px]"
      role="tablist"
      aria-label="Dataset selector"
    >
      {OPTIONS.map((opt) => {
        const active = dataset === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className="px-3 py-1.5 rounded transition-colors text-left"
            style={{
              background: active ? 'var(--accent-soft)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-h)',
              border: active
                ? '1px solid var(--accent)'
                : '1px solid transparent',
            }}
          >
            <div className="font-semibold leading-tight">{opt.label}</div>
            <div
              className="text-[9px] uppercase tracking-wider mt-0.5"
              style={{
                color: active ? 'var(--accent)' : 'var(--text-dim)',
              }}
            >
              {opt.sub}
            </div>
          </button>
        );
      })}
    </div>
  );
}
