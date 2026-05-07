// Block-selection mode toggle. When on, MapCanvas overlays a clickable circle
// layer over the heatmap source's points and supports drag-rectangle box
// select. Selected blocks (FIPS codes, plus `zip:<zcta>` synthetic keys for
// cross-anchor centroid fallback rows) drive a synthetic FlowRow set in
// CommuteView via filterFlowsBySelectedBlocks, narrowing the corridor
// visualization to the selected residents'/workers' contribution.
//
// Mounted directly under the ZIP/place selector in DashboardTile. Visual
// pattern matches DirectionToggle / HeatmapModeToggle so the left rail reads
// as a single grouping of segmented controls.

interface Props {
  active: boolean;
  selectedCount: number;
  onToggle: (next: boolean) => void;
  onClear: () => void;
}

export function BlockSelectionToggle({
  active,
  selectedCount,
  onToggle,
  onClear,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        Block Selection
      </span>
      <div className="flex items-stretch gap-1">
        <button
          type="button"
          role="switch"
          aria-checked={active}
          onClick={() => onToggle(!active)}
          className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors"
          style={{
            background: active ? 'var(--accent)' : 'rgba(255,255,255,0.03)',
            color: active ? '#1a1207' : 'var(--text)',
            borderColor: active ? 'var(--accent)' : 'var(--panel-border)',
          }}
          title={
            active
              ? 'Click blocks on the map (shift-click adds; drag a rectangle for groups). Cmd/Ctrl-drag adds to selection.'
              : 'Turn on to click or drag-select census blocks and filter corridors to those residents/workers.'
          }
        >
          {active ? 'Selecting Blocks · On' : 'Select Blocks'}
        </button>
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selected blocks"
            className="px-2.5 text-[11px] rounded-lg border transition-colors hover:bg-white/5"
            style={{
              color: 'var(--accent)',
              borderColor: 'var(--panel-border)',
              background: 'rgba(255,255,255,0.03)',
            }}
          >
            Clear ({selectedCount})
          </button>
        )}
      </div>
      {active && (
        <div className="text-[10px] leading-snug" style={{ color: 'var(--text-dim)' }}>
          Click a block to select; shift-click to add. Drag a rectangle on the
          map for groups (cmd/ctrl-drag adds).
        </div>
      )}
    </div>
  );
}
