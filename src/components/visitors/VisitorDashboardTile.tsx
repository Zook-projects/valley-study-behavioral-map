// VisitorDashboardTile — Left rail for the visitor view. Mirrors the visual
// language of the commute view's DashboardTile (frosted-glass aside, header
// chip, toggle stack) but with visitor-specific controls and stats.
//
// Sections: header, scope toggle, measure toggle, top origins list. The
// methodology footer is omitted for v1 — the data source line in the header
// already tells the story.

import { fmtInt, fmtPct } from '../../lib/format';
import { topOriginPlaces } from '../../lib/placerQueries';
import type {
  VisitorFlowRow,
  VisitorMeasure,
  VisitorScopeFilter,
} from '../../types/placer';
import { MeasureToggle } from './MeasureToggle';
import { ScopeToggle } from './ScopeToggle';

interface Props {
  visitorRows: VisitorFlowRow[];
  measure: VisitorMeasure;
  onMeasureChange: (m: VisitorMeasure) => void;
  scope: VisitorScopeFilter;
  onScopeChange: (s: VisitorScopeFilter) => void;
  totalVisits: number;
  totalVisitors: number;
  selectedOrigin: string | null;
  onSelectOrigin: (zip: string | null) => void;
}

export function VisitorDashboardTile({
  visitorRows,
  measure,
  onMeasureChange,
  scope,
  onScopeChange,
  totalVisits,
  totalVisitors,
  selectedOrigin,
  onSelectOrigin,
}: Props) {
  const total = measure === 'visits' ? totalVisits : totalVisitors;
  const topPlaces = topOriginPlaces(visitorRows, measure, scope, 15);

  return (
    <aside className="glass relative z-10 flex flex-col w-full md:w-[380px] md:h-full md:overflow-hidden">
      <div className="px-5 pt-5 pb-4 space-y-4 md:flex-1 md:overflow-y-auto">
        {/* Header — DatasetToggle now sits in the map area top-left (App.tsx),
            so the dashboard header no longer needs vertical clearance at the
            top of the panel. */}
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
              Visitor Origins · v1
            </span>
          </div>
          <h1
            className="text-[19px] font-semibold leading-tight"
            style={{ color: 'var(--text-h)', letterSpacing: '-0.01em' }}
          >
            Glenwood Springs
            <br />
            Visitor Origins
          </h1>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            Placer.ai · 2025 · destination ZIP 81601
          </div>
        </div>

        {/* Scope + measure toggles */}
        <ScopeToggle scope={scope} onChange={onScopeChange} />
        <MeasureToggle measure={measure} onChange={onMeasureChange} />

        {/* Headline number for the active measure */}
        <div
          className="rounded-md px-3 py-2"
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: 'var(--text-dim)' }}
          >
            {measure === 'visits' ? 'Total visits' : 'Unique visitors'}
            {' · '}
            {scope === 'local' ? 'within 75 mi' : 'all origins'}
          </div>
          <div
            className="text-[24px] font-semibold tnum mt-0.5"
            style={{ color: 'var(--text-h)' }}
          >
            {fmtInt(total)}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
            other measure: {fmtInt(measure === 'visits' ? totalVisitors : totalVisits)}{' '}
            {measure === 'visits' ? 'visitors' : 'visits'}
          </div>
        </div>

        {/* Top origins list */}
        <div>
          <div
            className="text-[10px] font-semibold uppercase tracking-[0.18em] mb-1.5"
            style={{ color: 'var(--text-dim)' }}
          >
            Top origin places
          </div>
          <ul className="space-y-0.5">
            {topPlaces.map((p) => {
              // A "place row" can span multiple ZIPs. Selection here keys on
              // the first ZIP — for v1 we don't aggregate origin selection
              // across the whole place; clicking the row simply highlights
              // the first ZIP's dot on the map.
              const repZip = p.zips[0];
              const value = measure === 'visits' ? p.visits : p.visitors;
              const share = total > 0 ? value / total : 0;
              const isSelected = selectedOrigin === repZip;
              return (
                <li key={`${p.place}|${p.state}`}>
                  <button
                    type="button"
                    onClick={() =>
                      onSelectOrigin(isSelected ? null : repZip)
                    }
                    className="w-full flex items-baseline gap-2 px-2 py-1 rounded transition-colors text-left text-[11px]"
                    style={{
                      background: isSelected ? 'var(--accent-soft)' : 'transparent',
                      border: isSelected
                        ? '1px solid var(--accent)'
                        : '1px solid transparent',
                    }}
                  >
                    <span
                      className="flex-1 truncate"
                      style={{
                        color: isSelected ? 'var(--accent)' : 'var(--text-h)',
                      }}
                    >
                      {p.place}
                      <span
                        className="ml-1 text-[10px]"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        · {p.state}
                        {p.scope === 'non-local' ? ' · non-local' : ''}
                      </span>
                    </span>
                    <span
                      className="tnum"
                      style={{
                        color: isSelected ? 'var(--accent)' : 'var(--text)',
                      }}
                    >
                      {fmtInt(value)}
                    </span>
                    <span
                      className="text-[10px] tnum w-9 text-right"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      {fmtPct(share)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </aside>
  );
}
