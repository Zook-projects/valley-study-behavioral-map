// TopBar — slim header strip with two view tabs (Map / Dashboard).
// Sticky to the top of the viewport. Active tab gets the warm-amber accent
// underline + bright text; inactive tabs are dim. Keyboard-accessible per
// the WAI-ARIA tabs pattern (left/right arrows + Home/End + Enter/Space).

import { useRef } from 'react';

export type AppView = 'map' | 'dashboard';

interface Props {
  view: AppView;
  onChange: (next: AppView) => void;
}

const TABS: ReadonlyArray<{ id: AppView; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'dashboard', label: 'Dashboard' },
];

export function TopBar({ view, onChange }: Props) {
  const buttonRefs = useRef<Record<AppView, HTMLButtonElement | null>>({
    map: null,
    dashboard: null,
  });

  const focusTab = (id: AppView) => {
    const btn = buttonRefs.current[id];
    btn?.focus();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const order: AppView[] = TABS.map((t) => t.id);
    const idx = order.indexOf(view);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = order[(idx + 1) % order.length];
      onChange(next);
      focusTab(next);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = order[(idx - 1 + order.length) % order.length];
      onChange(next);
      focusTab(next);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(order[0]);
      focusTab(order[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = order[order.length - 1];
      onChange(last);
      focusTab(last);
    }
  };

  return (
    <header
      className="sticky top-0 z-50 w-full glass"
      style={{
        borderBottom: '1px solid var(--panel-border)',
      }}
    >
      {/* Three-column layout: title left, tabs centered (flex-1 + center
          alignment puts the tablist at the visual midpoint of the bar),
          and an equally-sized spacer on the right so the tabs land in the
          true center regardless of title length. */}
      <div className="grid grid-cols-3 items-center px-3 md:px-4 h-12">
        <div
          className="text-[14px] font-semibold uppercase tracking-[0.18em] truncate justify-self-start"
          style={{ color: 'var(--text-h)' }}
        >
          Glenwood Springs&nbsp;
          <span style={{ color: 'var(--text-dim)' }}>
            · Economic Research
          </span>
        </div>
        <div
          role="tablist"
          aria-label="View"
          className="flex items-stretch gap-0.5 justify-self-center"
          onKeyDown={handleKey}
        >
          {TABS.map((tab) => {
            const active = tab.id === view;
            return (
              <button
                key={tab.id}
                ref={(el) => { buttonRefs.current[tab.id] = el; }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(tab.id)}
                className="relative px-3 md:px-4 text-[11px] font-medium uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-1"
                style={{
                  color: active ? 'var(--text-h)' : 'var(--text-dim)',
                }}
              >
                {tab.label}
                {/* Active-tab underline. Sits flush with the bottom border so
                    the bar reads as a tabbed nav. */}
                <span
                  aria-hidden="true"
                  className="absolute left-2 right-2 -bottom-px h-[2px] rounded-t"
                  style={{
                    background: active ? 'var(--accent)' : 'transparent',
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}
