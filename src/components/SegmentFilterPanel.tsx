// SegmentFilterPanel — leading column inside BottomCardStrip. Lets the user
// slice every cross-LODES OD aggregation by one of three axes (age / wage /
// industry NAICS-3) at a time. LODES does not publish joint cells across
// axes, so the UX commits to one axis at a time per the project plan.
//
// Top sub-row: 4 axis chips (All Workers · Age · Earnings · Industry).
// Bottom sub-row (visible when an axis is active): 3 multi-select bucket
// chips. When all 3 buckets within an axis are selected, the panel folds
// back to "All Workers" so the user lands in a single canonical no-filter
// state.

import type {
  AgeBucket,
  Naics3Bucket,
  SegmentAxis,
  SegmentBucket,
  SegmentFilter,
  WageBucket,
} from '../types/flow';

interface Props {
  value: SegmentFilter;
  onChange: (next: SegmentFilter) => void;
  // When true (per-anchor view), the axis chips stack vertically and the
  // panel narrows so the strip's leading column takes less horizontal room.
  compact?: boolean;
}

const AGE_BUCKETS: { key: AgeBucket; label: string }[] = [
  { key: 'u29', label: 'Under 30' },
  { key: 'age30to54', label: '30–54' },
  { key: 'age55plus', label: '55+' },
];
const WAGE_BUCKETS: { key: WageBucket; label: string }[] = [
  { key: 'low', label: '≤ $1,250/mo' },
  { key: 'mid', label: '$1,251–$3,333' },
  { key: 'high', label: '> $3,333/mo' },
];
const NAICS_BUCKETS: { key: Naics3Bucket; label: string }[] = [
  { key: 'goods', label: 'Goods' },
  { key: 'tradeTransUtil', label: 'Trade · Trans · Util' },
  { key: 'allOther', label: 'All Other Services' },
];

const AXIS_CHIPS: { key: SegmentAxis; label: string }[] = [
  { key: 'all', label: 'All Workers' },
  { key: 'age', label: 'Age' },
  { key: 'wage', label: 'Earnings' },
  { key: 'naics3', label: 'Industry' },
];

function bucketsForAxis(axis: SegmentAxis): { key: SegmentBucket; label: string }[] {
  if (axis === 'age') return AGE_BUCKETS;
  if (axis === 'wage') return WAGE_BUCKETS;
  if (axis === 'naics3') return NAICS_BUCKETS;
  return [];
}

// Visual treatment matches DirectionToggle and the rest of the strip:
// glass panel + amber `var(--accent)` for active state, no new tokens.
function Chip({
  active,
  onClick,
  children,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className="rounded-md px-2 py-1 text-[10px] tnum transition-colors"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-h)',
        background: active ? 'rgba(245, 158, 11, 0.12)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--panel-border)'}`,
      }}
    >
      {children}
    </button>
  );
}

export function SegmentFilterPanel({ value, onChange, compact = false }: Props) {
  const activeAxis = value.axis;
  const buckets = bucketsForAxis(activeAxis);

  const setAxis = (axis: SegmentAxis) => {
    if (axis === 'all') {
      onChange({ axis: 'all', buckets: [] });
      return;
    }
    // Switching axes resets bucket selection so the user lands in a clean
    // "no buckets selected — everyone in axis" state. We model "everyone in
    // axis" as the full bucket list so the displayed numbers match
    // axis: 'all' until the user narrows.
    const all = bucketsForAxis(axis).map((b) => b.key);
    onChange({ axis, buckets: all });
  };

  const toggleBucket = (b: SegmentBucket) => {
    const has = value.buckets.includes(b);
    const next = has
      ? value.buckets.filter((x) => x !== b)
      : [...value.buckets, b];
    // Keep the axis selection sticky — selecting every bucket within the
    // active axis is mathematically equivalent to no filter, but the user's
    // axis context persists until they explicitly pick "All Workers".
    onChange({ axis: value.axis, buckets: next });
  };

  return (
    <div
      className="glass rounded-md p-3 shrink-0 flex flex-col gap-2"
      style={{ width: compact ? 150 : 220 }}
    >
      <div>
        <div
          className="text-[10px] font-medium uppercase tracking-wider"
          style={{ color: 'var(--text-dim)' }}
        >
          Filter by segment
        </div>
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
          LODES segments
        </div>
      </div>
      <div
        className={
          compact ? 'flex flex-col gap-1 items-stretch' : 'flex flex-wrap gap-1'
        }
      >
        {AXIS_CHIPS.map((c) => (
          <Chip
            key={c.key}
            active={activeAxis === c.key}
            onClick={() => setAxis(c.key)}
            ariaLabel={`Filter by ${c.label}`}
          >
            {c.label}
          </Chip>
        ))}
      </div>
      {activeAxis !== 'all' && buckets.length > 0 && (
        <div className="flex flex-col gap-1 pt-1">
          <div
            className="text-[9px] uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Buckets
          </div>
          <div
            className={
              compact
                ? 'flex flex-col gap-1 items-stretch'
                : 'flex flex-wrap gap-1'
            }
          >
            {buckets.map((b) => (
              <Chip
                key={b.key}
                active={value.buckets.includes(b.key)}
                onClick={() => toggleBucket(b.key)}
                ariaLabel={`Toggle ${b.label}`}
              >
                {b.label}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
