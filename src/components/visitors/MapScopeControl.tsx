// MapScopeControl — three-preset zoom level chip cluster (Valley / State /
// National) for the visitor map. Each preset calls back into the parent which
// invokes MapLibre's fitBounds with one of MAP_SCOPE_BOUNDS.

import type { MapScope } from '../../types/placer';

interface Props {
  scope: MapScope;
  onChange: (next: MapScope) => void;
}

const PRESETS: Array<{ value: MapScope; label: string }> = [
  { value: 'valley', label: 'Valley' },
  { value: 'state', label: 'State' },
  { value: 'national', label: 'National' },
];

export function MapScopeControl({ scope, onChange }: Props) {
  return (
    <div
      className="glass rounded-md p-1 flex gap-1 text-[10px]"
      role="tablist"
      aria-label="Map zoom level"
    >
      {PRESETS.map((p) => {
        const active = scope === p.value;
        return (
          <button
            key={p.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(p.value)}
            className="px-2.5 py-1 rounded transition-colors font-medium uppercase tracking-wider"
            style={{
              background: active ? 'var(--accent-soft)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-h)',
              border: active
                ? '1px solid var(--accent)'
                : '1px solid transparent',
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
