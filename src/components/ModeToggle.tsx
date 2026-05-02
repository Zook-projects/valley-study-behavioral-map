// Inbound / Outbound segmented control — mirrors the "Live Map / Fleet / Routes"
// tab pattern in the Ron Design inspiration. The toggle renders in every view:
//  • anchor view → drives the user's mode (left panel + map both react)
//  • aggregate view → drives a separate `regionalViewMode` upstream that only
//    re-skins the corridor + heatmap visuals; the left panel / cards / tooltip
//    stay aggregated across both directions.
//  • non-anchor view → disabled (locked to inbound — anchor-inbound is the
//    only dataset whose origins include non-anchor places).

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
}

export function ModeToggle({ mode, onChange, disabled = false }: Props) {
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
