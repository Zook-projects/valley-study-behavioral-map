// Inbound / Outbound segmented control — mirrors the "Live Map / Fleet / Routes"
// tab pattern in the Ron Design inspiration. In the aggregate (no-ZIP-selected)
// view the toggle is replaced by a single non-interactive "Aggregate Regional
// Flows" label — the map renders the deduped union of inbound + outbound and
// neither single-direction view is meaningful at the regional scale.

import type { Mode } from '../types/flow';

interface Props {
  mode: Mode;
  onChange: (m: Mode) => void;
  // When true, the toggle renders in a locked state (used by the non-anchor
  // selection — the dataset is anchor-inbound only, so outbound has no
  // meaning and the toggle stays pinned to "inbound" until the user clears
  // the non-anchor selection). Buttons are non-interactive but keep their
  // active styling so the lock reads visually.
  disabled?: boolean;
  // When true, render a single "Aggregate Regional Flows" label instead of
  // the two-button group. Used in the aggregate (no-ZIP-selected) view.
  aggregate?: boolean;
}

export function ModeToggle({ mode, onChange, disabled = false, aggregate = false }: Props) {
  if (aggregate) {
    return (
      <div
        role="status"
        aria-label="Aggregate Regional Flows"
        className="flex p-1 rounded-lg border"
        style={{
          background: 'rgba(255,255,255,0.03)',
          borderColor: 'var(--panel-border)',
        }}
      >
        <div
          className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md text-center"
          style={{
            background: 'var(--accent)',
            color: '#1a1207',
          }}
        >
          Aggregate Regional Flows
        </div>
      </div>
    );
  }
  return (
    <div
      role="tablist"
      aria-label="Flow direction"
      aria-disabled={disabled || undefined}
      className="flex p-1 rounded-lg border"
      style={{
        background: 'rgba(255,255,255,0.03)',
        borderColor: 'var(--panel-border)',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {(['inbound', 'outbound'] as const).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={disabled ? undefined : () => onChange(m)}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#1a1207' : 'var(--text)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {m === 'inbound' ? 'Inbound (To)' : 'Outbound (From)'}
          </button>
        );
      })}
    </div>
  );
}
