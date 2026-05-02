// ScopeToggle — local-only / include-non-local switch for the visitor view.
// "Local only" filters to origins within 75 miles of Glenwood Springs;
// "Include non-local" surfaces the full 50-state long tail (Front Range,
// out-of-state).

import type { VisitorScopeFilter } from '../../types/placer';

interface Props {
  scope: VisitorScopeFilter;
  onChange: (next: VisitorScopeFilter) => void;
}

export function ScopeToggle({ scope, onChange }: Props) {
  const isLocal = scope === 'local';
  return (
    <div className="space-y-1">
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.18em]"
        style={{ color: 'var(--text-dim)' }}
      >
        Scope
      </div>
      <div
        className="rounded-md p-1 flex gap-1 text-[11px]"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
        role="tablist"
        aria-label="Scope"
      >
        <button
          type="button"
          role="tab"
          aria-selected={isLocal}
          onClick={() => onChange('local')}
          className="flex-1 px-2 py-1 rounded transition-colors"
          style={{
            background: isLocal ? 'var(--accent-soft)' : 'transparent',
            color: isLocal ? 'var(--accent)' : 'var(--text-h)',
            border: isLocal
              ? '1px solid var(--accent)'
              : '1px solid transparent',
          }}
        >
          <div className="font-semibold">Local only</div>
          <div
            className="text-[9px] uppercase tracking-wider"
            style={{ color: isLocal ? 'var(--accent)' : 'var(--text-dim)' }}
          >
            Within 75 mi
          </div>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!isLocal}
          onClick={() => onChange('all')}
          className="flex-1 px-2 py-1 rounded transition-colors"
          style={{
            background: !isLocal ? 'var(--accent-soft)' : 'transparent',
            color: !isLocal ? 'var(--accent)' : 'var(--text-h)',
            border: !isLocal
              ? '1px solid var(--accent)'
              : '1px solid transparent',
          }}
        >
          <div className="font-semibold">Include non-local</div>
          <div
            className="text-[9px] uppercase tracking-wider"
            style={{ color: !isLocal ? 'var(--accent)' : 'var(--text-dim)' }}
          >
            All 50 states
          </div>
        </button>
      </div>
    </div>
  );
}
