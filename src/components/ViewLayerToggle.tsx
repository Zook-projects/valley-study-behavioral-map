// Corridor / Heatmap segmented control. Picks which spatial visualization
// the map area renders: the flow-arc corridor view (default) or the block-
// level density heatmap. Sits above DirectionToggle in DashboardTile.
//
// Visually and structurally mirrors DirectionToggle.tsx.

export type ViewLayer = 'corridor' | 'heatmap';

interface Props {
  value: ViewLayer;
  onChange: (next: ViewLayer) => void;
}

const OPTIONS: ReadonlyArray<{ value: ViewLayer; label: string }> = [
  { value: 'corridor', label: 'Corridor' },
  { value: 'heatmap', label: 'Heatmap' },
];

export function ViewLayerToggle({ value, onChange }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        View
      </span>
      <div
        role="tablist"
        aria-label="Map visualization layer"
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
