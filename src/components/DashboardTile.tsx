// Frosted-glass left dashboard tile. Composes header, mode toggle, ZIP selector,
// stats, and methodology footer. Accepts the global selection state via props.

import type { DirectionFilter, FlowRow, Mode, SegmentFilter, ZipMeta } from '../types/flow';
import type { DriveDistanceMap } from '../lib/flowQueries';
import { ModeToggle } from './ModeToggle';
import { DirectionToggle } from './DirectionToggle';
import { ViewLayerToggle, type ViewLayer } from './ViewLayerToggle';
import { HeatmapModeToggle, type HeatmapSide } from './HeatmapModeToggle';
import { BlockSelectionToggle } from './BlockSelectionToggle';
import { ZipSelector } from './ZipSelector';
import { StatsAggregated } from './StatsAggregated';
import { StatsForZip } from './StatsForZip';
import { MethodologyFooter } from './MethodologyFooter';
import type { ContextBundle } from '../types/context';

interface Props {
  // Active-mode dataset — used for both aggregated and per-ZIP stats. The
  // per-ZIP stats panel keeps strict mode-exclusivity; the aggregated panel
  // (Option B) renders side-by-side inbound + outbound figures and so also
  // receives the inactive-mode set below.
  flows: FlowRow[];
  // Same dataset, with the direction filter applied. Stats use this for
  // top-N corridors / totals; the unfiltered `flows` is preserved so the
  // self-flow and ALL_OTHER callouts can stay pinned across direction states.
  directionFilteredFlows: FlowRow[];
  // Both datasets — needed by StatsAggregated to render both directions in
  // each tile while highlighting the active mode.
  flowsInbound: FlowRow[];
  flowsOutbound: FlowRow[];
  directionFilteredInbound: FlowRow[];
  directionFilteredOutbound: FlowRow[];
  zips: ZipMeta[];
  mode: Mode;
  onModeChange: (m: Mode) => void;
  // Toggle binding for ModeToggle — in anchor view it mirrors `mode`. In
  // aggregate view ModeToggle renders the static "Aggregate Regional Flows"
  // label so this prop is effectively unused but kept consistent with mode.
  viewMode: Mode;
  onViewModeChange: (m: Mode) => void;
  // Independent heatmap-side state — drives the Workplace / Residence
  // sub-toggle that slides out under ViewLayerToggle when the heatmap
  // layer is active. Decoupled from `mode` / `viewMode` so all four
  // (mode × heatmapSide) combinations are reachable.
  heatmapSide: HeatmapSide;
  onHeatmapSideChange: (s: HeatmapSide) => void;
  selectedZip: string | null;
  onSelectZip: (z: string | null) => void;
  // Selection class — drives the toggle/notice swap and the StatsForZip
  // origin-pivot branch. Source of truth lives in App.tsx.
  selectionKind: 'aggregate' | 'anchor' | 'non-anchor';
  // Set when selectionKind === 'non-anchor'. Carries the place name and
  // every ZIP that shares it (e.g. Eagle 81631+81637).
  nonAnchorBundle: { place: string; zips: string[] } | null;
  // Visible flows from App — the map-facing dataset. For non-anchor it's
  // the aggregate inbound network (so the map keeps its full context); for
  // anchor / aggregate it's the selection-narrowed flows. Stats panels use
  // `bundleFlows` (below) for non-anchor pivots instead of redoing the work.
  visibleFlows: FlowRow[];
  // Origin-pivot rows for the non-anchor selection — one row per anchor
  // destination, already aggregated by destination across the bundle's ZIPs.
  // Empty array for anchor / aggregate selections.
  bundleFlows: FlowRow[];
  // Optional secondary partner selection (a single row from the anchor's
  // top-N list). Plumbed through to StatsForZip; null in aggregate view.
  selectedPartner: { place: string; zips: string[] } | null;
  onSelectPartner: (p: { place: string; zips: string[] } | null) => void;
  directionFilter: DirectionFilter;
  onDirectionChange: (d: DirectionFilter) => void;
  // Spatial visualization layer — corridor (flow arcs) vs heatmap
  // (block-level density). Toggle sits directly above DirectionToggle.
  viewLayer: ViewLayer;
  onViewLayerChange: (v: ViewLayer) => void;
  // Quantile breaks for the corridor width × luminance legend. Recomputed
  // upstream when mode/visible flows change.
  bucketBreaks: [number, number, number, number];
  // Heaviest corridor for each mode (direction-filtered, no selection
  // narrowing). Drives the dual-rendered "Top corridor" tile in
  // StatsAggregated.
  topCorridorInbound: { label: string; total: number } | null;
  topCorridorOutbound: { label: string; total: number } | null;
  // Precomputed OSRM drive-distance lookup for the average-commute stat.
  // Optional — null falls back to Haversine × detour-factor.
  driveDistance: DriveDistanceMap | null;
  // Heatmap legend props — mirror the legend that previously rendered as
  // a standalone overlay above the bottom card strip. The legend now lives
  // inside the methodology footer's expanded panel.
  heatmapVisible: boolean;
  heatmapLegendSide: HeatmapSide;
  segmentFilter: SegmentFilter;
  // Optional regional context bundle — passed straight through to the
  // methodology footer so its Sources block can list every agency.
  contextBundle?: ContextBundle | null;
  // Block-selection mode — when on, the map overlays a clickable circle layer
  // over the heatmap source and supports drag-rectangle box select. Selected
  // blocks drive a synthetic FlowRow set in CommuteView that narrows the
  // corridor visualization to the selected residents'/workers' contribution.
  blockSelectionActive: boolean;
  onBlockSelectionActiveChange: (next: boolean) => void;
  selectedBlockCount: number;
  onClearSelectedBlocks: () => void;
  // Block-selection side / mode / hide — independent state owned by
  // CommuteView so the BlockSelectionToggle and the panel pivot stay in sync.
  blockSelectionSide: HeatmapSide;
  onBlockSelectionSideChange: (next: HeatmapSide) => void;
  blockSelectionMode: Mode;
  onBlockSelectionModeChange: (next: Mode) => void;
  blocksHidden: boolean;
  onBlocksHiddenChange: (next: boolean) => void;
  // True when block selection is on AND at least one block is selected.
  // When true, the panel pivots from the canonical anchor / aggregate /
  // non-anchor selectionKind branches into a synthetic 'blocks' branch.
  blockScopeActive: boolean;
  // Synthetic block-selection bundle — shape parallels the non-anchor
  // bundle: a label, a headline total, top-N partner aggregates by place.
  // Null when blockScopeActive is false.
  blockSelectionBundle:
    | {
        label: string;
        selectedCount: number;
        totalWorkers: number;
        topRows: Array<{ place: string; zips: string[]; workerCount: number }>;
        mode: Mode;
      }
    | null;
}

export function DashboardTile({
  flows,
  directionFilteredFlows,
  flowsInbound,
  flowsOutbound,
  directionFilteredInbound,
  directionFilteredOutbound,
  zips,
  mode,
  viewMode,
  onViewModeChange,
  heatmapSide,
  onHeatmapSideChange,
  selectedZip,
  onSelectZip,
  selectionKind,
  nonAnchorBundle,
  visibleFlows,
  bundleFlows,
  selectedPartner,
  onSelectPartner,
  directionFilter,
  onDirectionChange,
  viewLayer,
  onViewLayerChange,
  bucketBreaks,
  topCorridorInbound,
  topCorridorOutbound,
  driveDistance,
  heatmapVisible,
  heatmapLegendSide,
  segmentFilter,
  contextBundle = null,
  blockSelectionActive,
  onBlockSelectionActiveChange,
  selectedBlockCount,
  onClearSelectedBlocks,
  blockSelectionSide,
  onBlockSelectionSideChange,
  blockSelectionMode,
  onBlockSelectionModeChange,
  blocksHidden,
  onBlocksHiddenChange,
  blockScopeActive,
  blockSelectionBundle,
}: Props) {
  return (
    <aside
      className="glass relative z-10 flex flex-col w-full md:w-[380px] md:h-full md:overflow-hidden"
    >
      <div className="px-5 pt-5 pb-4 space-y-4 md:flex-1 md:overflow-y-auto">
        {/* Header */}
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--accent)' }}
            >
              Movement Patterns Map · v2
            </span>
          </div>
          <h1
            className="text-[19px] font-semibold leading-tight"
            style={{ color: 'var(--text-h)', letterSpacing: '-0.01em' }}
          >
            Roaring Fork & Colorado River
            <br />
            Valley Commuters
          </h1>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            2002–2023 LEHD LODES8 · 11 workplace ZIP codes
          </div>
        </div>

        {/* Mode toggle. When a non-anchor place is selected the toggle stays
            in place but renders disabled and pinned to 'inbound' — the
            anchor-inbound dataset is the only one that contains rows whose
            origin is the selected place, so outbound has no meaning here.
            A "Back to aggregate view" link sits directly beneath so the
            user can clear the lock without having to re-target the selector. */}
        {/* In aggregate view ModeToggle short-circuits to the static
            "Aggregate Regional Flows" label, so viewMode is effectively
            unused there. In anchor view it mirrors the user's mode; in
            non-anchor view it stays disabled and locked to inbound. */}
        {/* When block selection is the active scope, the ModeToggle pivots
            to the block-selection mode (defaults to outbound). The canonical
            anchor / aggregate / non-anchor branching is preserved otherwise. */}
        {blockScopeActive ? (
          <ModeToggle
            mode={blockSelectionMode}
            onChange={onBlockSelectionModeChange}
          />
        ) : (
          <ModeToggle
            mode={viewMode}
            onChange={onViewModeChange}
            disabled={selectionKind === 'non-anchor'}
            aggregate={selectionKind === 'aggregate'}
          />
        )}
        {selectionKind === 'non-anchor' && nonAnchorBundle && (
          <div className="-mt-2">
            <button
              type="button"
              onClick={() => onSelectZip(null)}
              className="text-[11px] underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
              style={{ color: 'var(--accent)' }}
            >
              ← Back to aggregate view
            </button>
          </div>
        )}

        {/* View-layer toggle (sits above direction — picks corridor flow
            arcs vs block-level heatmap). */}
        <ViewLayerToggle value={viewLayer} onChange={onViewLayerChange} />

        {/* Heatmap-only Residence / Workplace toggle. Slides out from behind
            the Corridor / Heatmap row when heatmap is active and the heatmap
            layer is actually visible (i.e. not non-anchor). Drives an
            INDEPENDENT heatmap-side state — decoupled from the canonical
            mode so every (mode × heatmapSide) combination is reachable in
            anchor view. */}
        <HeatmapModeToggle
          side={heatmapSide}
          onChange={onHeatmapSideChange}
          visible={viewLayer === 'heatmap' && selectionKind !== 'non-anchor'}
        />

        {/* Direction toggle (independent — composes with mode) */}
        <DirectionToggle value={directionFilter} onChange={onDirectionChange} />

        {/* ZIP selector */}
        <ZipSelector
          zips={zips}
          selectedZip={selectedZip}
          onSelectZip={onSelectZip}
        />

        {/* Block-selection mode — sits directly under the ZIP/place selector.
            Always available (per design). When on, MapCanvas overlays a
            clickable circle layer over the heatmap source so the user can
            click or drag-select residential / workplace blocks; selection
            narrows the corridor visualization to those blocks' flows. */}
        <BlockSelectionToggle
          active={blockSelectionActive}
          selectedCount={selectedBlockCount}
          onToggle={onBlockSelectionActiveChange}
          onClear={onClearSelectedBlocks}
          side={blockSelectionSide}
          onSideChange={onBlockSelectionSideChange}
          hidden={blocksHidden}
          onHiddenChange={onBlocksHiddenChange}
        />

        {/* Stats */}
        <div>
          {blockScopeActive && blockSelectionBundle ? (
            <StatsForZip
              flows={flows}
              directionFilteredFlows={directionFilteredFlows}
              flowsInbound={flowsInbound}
              directionFilter={directionFilter}
              zips={zips}
              // selectedZip stays whatever the user last picked (or null) —
              // the 'blocks' branch in StatsForZip ignores it and reads
              // blockSelectionBundle instead.
              selectedZip={selectedZip ?? 'BLOCKS'}
              selectionKind="blocks"
              nonAnchorBundle={null}
              visibleFlows={visibleFlows}
              bundleFlows={bundleFlows}
              mode={blockSelectionMode}
              blockSelectionBundle={blockSelectionBundle}
              selectedPartner={selectedPartner}
              onSelectPartner={onSelectPartner}
              onReset={() => onSelectZip(null)}
            />
          ) : selectedZip ? (
            <StatsForZip
              flows={flows}
              directionFilteredFlows={directionFilteredFlows}
              flowsInbound={flowsInbound}
              directionFilter={directionFilter}
              zips={zips}
              selectedZip={selectedZip}
              selectionKind={selectionKind}
              nonAnchorBundle={nonAnchorBundle}
              visibleFlows={visibleFlows}
              bundleFlows={bundleFlows}
              mode={mode}
              selectedPartner={selectedPartner}
              onSelectPartner={onSelectPartner}
              onReset={() => onSelectZip(null)}
            />
          ) : (
            <StatsAggregated
              flowsInbound={flowsInbound}
              flowsOutbound={flowsOutbound}
              directionFilteredInbound={directionFilteredInbound}
              directionFilteredOutbound={directionFilteredOutbound}
              directionFilter={directionFilter}
              mode={mode}
              topCorridorInbound={topCorridorInbound}
              topCorridorOutbound={topCorridorOutbound}
              zips={zips}
              driveDistance={driveDistance}
            />
          )}
        </div>

        {/* Year toggle (locked, future-ready) */}
        <div
          className="rounded-md px-2.5 py-1.5 flex items-center justify-between"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--panel-border)',
          }}
        >
          <span
            className="text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Vintage
          </span>
          <span className="text-xs tnum" style={{ color: 'var(--text-h)' }}>
            2002–2023
          </span>
        </div>
      </div>

      {/* Footer */}
      <div
        className="px-5 py-3.5 border-t"
        style={{ borderColor: 'var(--panel-border)' }}
      >
        <MethodologyFooter
          bucketBreaks={bucketBreaks}
          amberSwatches={selectedZip == null}
          heatmapVisible={heatmapVisible}
          heatmapSide={heatmapLegendSide}
          selectedZip={selectedZip}
          zips={zips}
          segmentFilter={segmentFilter}
          contextBundle={contextBundle}
        />
      </div>
    </aside>
  );
}
