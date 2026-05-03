// Residence / Workplace segmented control. Visible only when the View layer
// toggle is set to "heatmap" — slides out from behind the Corridor / Heatmap
// row. Drives an INDEPENDENT heatmap-side state — decoupled from the
// canonical inbound / outbound mode so all four combinations are reachable:
//   • inbound + workplace → blocks where incoming workers WORK (within anchor)
//   • inbound + residence → blocks where incoming workers LIVE (anywhere)
//   • outbound + residence → blocks where outgoing residents LIVE (within anchor)
//   • outbound + workplace → blocks where outgoing residents WORK (anywhere)
// In non-anchor view the heatmap is hidden, so the toggle is unreachable.

export type HeatmapSide = 'workplace' | 'residence';

interface Props {
  side: HeatmapSide;
  onChange: (next: HeatmapSide) => void;
  // Drives the slide / fade-in animation. When false, the toggle collapses
  // to zero height and is removed from the tab order.
  visible: boolean;
}

const OPTIONS: ReadonlyArray<{ value: HeatmapSide; label: string }> = [
  { value: 'workplace', label: 'Workplace' },
  { value: 'residence', label: 'Residence' },
];

export function HeatmapModeToggle({ side, onChange, visible }: Props) {
  return (
    <div
      aria-hidden={!visible}
      className="overflow-hidden transition-all duration-300 ease-out"
      style={{
        // Slide-out: collapses to 0 height when hidden so the toggle below
        // moves up flush against ViewLayerToggle. The negative top margin
        // when visible pulls it tight to the row above so the slide reads
        // as emerging from behind the Corridor / Heatmap toggle.
        maxHeight: visible ? 80 : 0,
        opacity: visible ? 1 : 0,
        marginTop: visible ? 6 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <div
        role="tablist"
        aria-label="Heatmap layer"
        className="flex p-1 rounded-lg border"
        style={{
          background: 'rgba(255,255,255,0.03)',
          borderColor: 'var(--panel-border)',
        }}
      >
        {OPTIONS.map(({ value, label }) => {
          const active = side === value;
          return (
            <button
              key={value}
              role="tab"
              aria-selected={active}
              tabIndex={visible ? 0 : -1}
              onClick={() => onChange(value)}
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
