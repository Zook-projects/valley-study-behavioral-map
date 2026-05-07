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
//
// Adjacent controls (visible only when block selection is active or has
// selections):
//   - Hide Blocks: filters MapCanvas's selection-circle layer to render
//     only the selected dots; the heatmap density underneath stays visible.
//   - Workplace / Residence: independent block-selection side toggle. Drives
//     which side of LODES the selectable block universe pulls from. Defaults
//     to Residence whenever block selection turns on.

import type { HeatmapSide } from './HeatmapModeToggle';

interface Props {
  active: boolean;
  selectedCount: number;
  onToggle: (next: boolean) => void;
  onClear: () => void;
  // Block-selection side. Renders the inline workplace/residence sub-toggle
  // when block selection is active. Source of truth lives in CommuteView so
  // the side flip can also clear the selection set.
  side: HeatmapSide;
  onSideChange: (next: HeatmapSide) => void;
  // Hide-blocks toggle — only meaningful when at least one block is selected.
  hidden: boolean;
  onHiddenChange: (next: boolean) => void;
}

const SIDE_OPTIONS: ReadonlyArray<{ value: HeatmapSide; label: string }> = [
  { value: 'workplace', label: 'Workplace' },
  { value: 'residence', label: 'Residence' },
];

export function BlockSelectionToggle({
  active,
  selectedCount,
  onToggle,
  onClear,
  side,
  onSideChange,
  hidden,
  onHiddenChange,
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
        {/* Hide / Show Blocks — sibling to Select Blocks. Surfaces only after
            the user has at least one selection so it never sits idle. The
            label flips when active so state reads at a glance. */}
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={() => onHiddenChange(!hidden)}
            aria-pressed={hidden}
            className="px-2.5 text-[11px] rounded-lg border transition-colors"
            style={{
              color: hidden ? '#1a1207' : 'var(--text)',
              borderColor: hidden ? 'var(--accent)' : 'var(--panel-border)',
              background: hidden ? 'var(--accent)' : 'rgba(255,255,255,0.03)',
            }}
            title={
              hidden
                ? 'Show all blocks again on the map.'
                : 'Hide unselected blocks on the map (selection preserved).'
            }
          >
            {hidden ? 'Show Blocks' : 'Hide Blocks'}
          </button>
        )}
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
      {/* Workplace / Residence inline sub-toggle — visible only when block
          selection is active. Mirrors the segmented-control styling used by
          HeatmapModeToggle so the rail reads as one grouping. Switching
          flips the selectable block universe; CommuteView clears the
          selection set on side change. */}
      {active && (
        <div
          role="tablist"
          aria-label="Block selection side"
          className="flex p-1 rounded-lg border"
          style={{
            background: 'rgba(255,255,255,0.03)',
            borderColor: 'var(--panel-border)',
          }}
        >
          {SIDE_OPTIONS.map(({ value, label }) => {
            const isActive = side === value;
            return (
              <button
                key={value}
                role="tab"
                aria-selected={isActive}
                onClick={() => onSideChange(value)}
                className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
                style={{
                  background: isActive ? 'var(--accent)' : 'transparent',
                  color: isActive ? '#1a1207' : 'var(--text)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {active && (
        <div className="text-[10px] leading-snug" style={{ color: 'var(--text-dim)' }}>
          Click a block to select; shift-click to add. Drag a rectangle on the
          map for groups (cmd/ctrl-drag adds).
        </div>
      )}
    </div>
  );
}
