// HeatmapLegend — compact panel describing the active block-level heatmap.
// Renders a 5-step white gradient bar that mirrors the MapCanvas heatmap
// paint stops, plus a dynamic title reflecting the current view (regional /
// anchor inbound / anchor outbound) and an optional segment-filter line.
//
// Placement: bottom-left of the map area, clearing the left dashboard panel
// (md:w-[380px] in DashboardTile.tsx) and the bottom card strip (height
// tracked at runtime in CommuteView.tsx → bottomStripHeight). The parent
// passes that strip height through `bottomOffset`.
//
// Hidden whenever the heatmap layer itself is hidden (non-anchor selection
// or unloaded data) — the parent gates rendering via `visible`.

import type { SegmentFilter } from '../types/flow';
import type { ZipMeta } from '../types/flow';
import { isSegmentFilterAll } from '../lib/flowQueries';

interface Props {
  mode: 'inbound' | 'outbound' | 'regional';
  selectedZip: string | null;
  zips: ZipMeta[];
  segmentFilter: SegmentFilter;
  visible: boolean;
  // Pixel offset from the bottom of the map area. Tracks the bottom card
  // strip's measured height (set in CommuteView.tsx) plus a small gap so
  // the legend always clears the strip across view changes.
  bottomOffset: number;
}

// Friendly label for the active segment filter — mirrors the wording used
// elsewhere in the dashboard (italic small caps when displayed). Returns
// null when the filter is inactive so the caller can skip the second line.
function describeSegmentFilter(filter: SegmentFilter): string | null {
  if (isSegmentFilterAll(filter)) return null;
  if (filter.buckets.length === 0) return null;
  const axisLabel =
    filter.axis === 'age'
      ? 'Age'
      : filter.axis === 'wage'
      ? 'Wage'
      : 'Industry';
  const bucketLabels = filter.buckets.map((b) => {
    switch (b) {
      case 'u29':
        return 'Under 29';
      case 'age30to54':
        return '30–54';
      case 'age55plus':
        return '55+';
      case 'low':
        return 'Low';
      case 'mid':
        return 'Mid';
      case 'high':
        return 'High';
      case 'goods':
        return 'Goods';
      case 'tradeTransUtil':
        return 'Trade/Trans/Util';
      case 'allOther':
        return 'All other';
    }
  });
  return `${axisLabel}: ${bucketLabels.join(', ')}`;
}

export function HeatmapLegend({
  mode,
  selectedZip,
  zips,
  segmentFilter,
  visible,
  bottomOffset,
}: Props) {
  if (!visible) return null;

  // Title — what the gradient is reading. The regional view tracks the
  // user's regional-view-mode toggle, so the wording flips between
  // workplace and residential density alongside the corridor visuals.
  let title: string;
  if (!selectedZip || selectedZip === 'ALL_OTHER') {
    title =
      mode === 'outbound'
        ? 'Residential density — all anchors'
        : 'Workplace density — all anchors';
  } else {
    const meta = zips.find((z) => z.zip === selectedZip);
    const placeLabel = meta?.place ?? selectedZip;
    const anchorLabel = `${placeLabel} (${selectedZip})`;
    title =
      mode === 'outbound'
        ? `Residential density — ${anchorLabel}`
        : `Workplace density — ${anchorLabel}`;
  }

  const segmentLabel = describeSegmentFilter(segmentFilter);

  return (
    <div
      className="glass absolute rounded-md px-3 py-2 text-[11px] z-20 pointer-events-none"
      style={{
        // The legend sits inside the map area (which already begins to the
        // right of the left dashboard panel), so a small left gutter is all
        // that's needed for it to hug the map's left edge.
        left: 16,
        bottom: bottomOffset,
        color: 'var(--text-h)',
        // Cap the legend's footprint so it never crowds the map at narrow
        // desktop widths — content stays single-line within this width.
        maxWidth: 240,
      }}
    >
      <div
        className="uppercase tracking-widest"
        style={{ fontSize: 10, color: 'var(--text-dim)' }}
      >
        Block-level density
      </div>
      <div className="mt-0.5 leading-tight" style={{ color: 'var(--text-h)' }}>
        {title}
      </div>
      {/* 5 discrete white bands — mirrors the stepped heatmap-color stops in
          MapCanvas.tsx. Each cell is one band; the dark pad behind the row
          keeps the lowest-alpha cell readable against the glass backdrop. */}
      <div
        className="mt-1.5 h-2 w-full rounded-sm flex overflow-hidden"
        style={{
          background: 'rgba(0,0,0,0.45)',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
        }}
      >
        <div className="flex-1 h-full" style={{ background: 'rgba(255,255,255,0)' }} />
        <div className="flex-1 h-full" style={{ background: 'rgba(255,255,255,0.20)' }} />
        <div className="flex-1 h-full" style={{ background: 'rgba(255,255,255,0.45)' }} />
        <div className="flex-1 h-full" style={{ background: 'rgba(255,255,255,0.70)' }} />
        <div className="flex-1 h-full" style={{ background: 'rgba(255,255,255,0.95)' }} />
      </div>
      <div
        className="mt-0.5 flex justify-between"
        style={{ fontSize: 10, color: 'var(--text-dim)' }}
      >
        <span>Lower</span>
        <span>Higher</span>
      </div>
      {segmentLabel ? (
        <div
          className="mt-1 italic"
          style={{ fontSize: 10, color: 'var(--text-dim)' }}
        >
          {segmentLabel}
        </div>
      ) : null}
    </div>
  );
}
