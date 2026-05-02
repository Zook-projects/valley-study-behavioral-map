// VisitorBottomCardStrip — Horizontal strip pinned to the bottom of the map
// for the visitor view. Mirrors the commute view's strip in spirit (same
// frosted-glass language, tile-based layout) but holds visitor-specific tiles:
// totals, YoY change, local / non-local split, top corridor.

import { useMemo, type RefObject } from 'react';
import { fmtInt, fmtPct } from '../../lib/format';
import type {
  VisitorFlowRow,
  VisitorMeasure,
  VisitorScopeFilter,
  VisitorSummaryFile,
} from '../../types/placer';

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  visitorRows: VisitorFlowRow[];
  summary: VisitorSummaryFile;
  measure: VisitorMeasure;
  scope: VisitorScopeFilter;
  topCorridorLabel: string | null;
  topCorridorTotal: number;
}

export function VisitorBottomCardStrip({
  containerRef,
  visitorRows,
  summary,
  measure,
  scope,
  topCorridorLabel,
  topCorridorTotal,
}: Props) {
  // Headline + YoY for the active scope. summary.byScope splits totals; we
  // dual-render the unscoped (full) total so the user can see the share of
  // local vs total at a glance.
  const local = summary.byScope.local;
  const nonLocal = summary.byScope['non-local'];
  const radius = summary.localRadiusMiles;

  const scopeTotal = useMemo(() => {
    if (scope === 'local') {
      return measure === 'visits' ? local.visits : local.visitors;
    }
    return measure === 'visits' ? summary.totals.visits : summary.totals.visitors;
  }, [scope, measure, local, summary.totals]);

  // YoY: sum the per-row signed YoY values across the active scope. Rows
  // tagged "Insignificant YOY change" / "N/A" become null and contribute 0.
  const scopeYoy = useMemo(() => {
    let s = 0;
    for (const r of visitorRows) {
      if (scope === 'local' && r.scope !== 'local') continue;
      const v = measure === 'visits' ? r.metrics.visitsYoY : r.metrics.visitorsYoY;
      if (v != null) s += v;
    }
    return s;
  }, [visitorRows, scope, measure]);

  const fullScopeShare =
    scopeTotal > 0
      ? scope === 'local'
        ? local[measure] / Math.max(summary.totals[measure], 1)
        : 1
      : 0;

  const tiles: Array<{ label: string; value: string; sub?: string }> = [
    {
      label:
        measure === 'visits'
          ? scope === 'local'
            ? 'Local visits'
            : 'Total visits'
          : scope === 'local'
          ? 'Local visitors'
          : 'Total visitors',
      value: fmtInt(scopeTotal),
      sub:
        scope === 'local'
          ? `${fmtPct(fullScopeShare)} of all origins`
          : `${fmtInt(local[measure])} local · ${fmtInt(nonLocal[measure])} non-local`,
    },
    {
      label: 'YoY change',
      value: scopeYoy === 0 ? '—' : `${scopeYoy >= 0 ? '+' : ''}${fmtInt(scopeYoy)}`,
      sub:
        scopeYoy === 0
          ? 'no significant signal'
          : `vs. 2024 · ${measure === 'visits' ? 'visits' : 'visitors'}`,
    },
    {
      label: 'Origin places',
      value: fmtInt(
        scope === 'local'
          ? local.originCount
          : local.originCount + nonLocal.originCount,
      ),
      sub:
        scope === 'local'
          ? `Within ${radius} mi of Glenwood`
          : `${fmtInt(local.originCount)} local · ${fmtInt(nonLocal.originCount)} non-local`,
    },
    {
      label: 'Top corridor',
      value: topCorridorLabel || '—',
      sub: topCorridorLabel
        ? `${fmtInt(topCorridorTotal)} ${measure}`
        : 'no routable flows',
    },
  ];

  return (
    <div
      ref={containerRef}
      className="absolute bottom-0 left-0 right-0 z-20 px-3 py-3 md:px-4 md:py-3"
    >
      <div className="flex flex-wrap gap-2">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="glass rounded-md px-3 py-2 flex-1 min-w-[160px]"
          >
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: 'var(--text-dim)' }}
            >
              {t.label}
            </div>
            <div
              className="text-[18px] font-semibold tnum mt-0.5 leading-tight truncate"
              style={{ color: 'var(--text-h)' }}
              title={t.value}
            >
              {t.value}
            </div>
            {t.sub && (
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                {t.sub}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
