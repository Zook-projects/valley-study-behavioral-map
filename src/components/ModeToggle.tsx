// Inbound / Outbound segmented control — mirrors the "Live Map / Fleet / Routes"
// tab pattern in the Ron Design inspiration.

import type { Mode } from '../types/flow';

interface Props {
  mode: Mode;
  onChange: (m: Mode) => void;
}

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Flow direction"
      className="flex p-1 rounded-lg border"
      style={{
        background: 'rgba(255,255,255,0.03)',
        borderColor: 'var(--panel-border)',
      }}
    >
      {(['inbound', 'outbound'] as const).map((m) => {
        const active = mode === m;
        return (
          <button
            key={m}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m)}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#1a1207' : 'var(--text)',
            }}
          >
            {m === 'inbound' ? 'Inbound (To)' : 'Outbound (From)'}
          </button>
        );
      })}
    </div>
  );
}
