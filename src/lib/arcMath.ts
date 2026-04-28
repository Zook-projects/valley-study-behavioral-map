// Log-scale stroke + share-of-anchor opacity for the unique-edge layer.

export interface PathPoint { x: number; y: number; }

/**
 * Stroke width on a log scale. Used by the unique-edge renderer against the
 * aggregated worker count for each edge — corridors with many flows stack
 * naturally because their aggregated total is the sum of all flows passing
 * through. A 0.6 px floor keeps low-traffic edges visible at low zoom.
 */
export function strokeWidthFor(
  workerCount: number,
  maxWorkers: number,
  minPx = 0.6,
  maxPx = 4.5,
): number {
  if (workerCount <= 0 || maxWorkers <= 0) return minPx;
  const t = Math.log1p(workerCount) / Math.log1p(maxWorkers);
  return minPx + (maxPx - minPx) * t;
}

/**
 * Opacity scaled to share-of-total at the destination ZIP, capped to keep
 * small flows visible. Floor of 0.18 ensures even 1% flows are findable.
 */
export function opacityFor(percentage: number): number {
  return Math.max(0.18, Math.min(0.85, 0.25 + percentage * 1.5));
}

// ---------------------------------------------------------------------------
// Corridor bucket encoding — width × luminance redundant channel.
// ---------------------------------------------------------------------------
//
// Worker volume is encoded on two channels at once: stroke width and a
// neutral luminance ramp against the dark base. Quantile breakpoints land
// at 0.20, 0.45, 0.70, 0.90 — tuned for a long-tailed distribution where
// Hwy 82 Carbondale–Glenwood dominates. Breaks are recomputed per active
// mode (inbound and outbound have different distributions); the amber
// hover/selection state stays unique to interaction.

export type CorridorBucket = 1 | 2 | 3 | 4 | 5;

export interface CorridorStyle {
  bucket: CorridorBucket;
  width: number;
  color: string;
  opacity: number;
}

const BUCKET_STYLES: Record<CorridorBucket, Omit<CorridorStyle, 'bucket'>> = {
  1: { width: 1.0,  color: 'var(--corridor-1)', opacity: 0.55 },
  2: { width: 1.75, color: 'var(--corridor-2)', opacity: 0.70 },
  3: { width: 2.75, color: 'var(--corridor-3)', opacity: 0.82 },
  4: { width: 4.25, color: 'var(--corridor-4)', opacity: 0.92 },
  5: { width: 6.5,  color: 'var(--corridor-5)', opacity: 1.0  },
};

/**
 * Compute the four quantile breakpoints (0.20, 0.45, 0.70, 0.90) over the
 * active-mode corridor totals. Memoize the call site by [mode, selectedZip]
 * — recomputing per render is wasted work; recomputing per-mode-change is
 * required because inbound and outbound have different distributions.
 */
export function computeBucketBreaks(
  totals: number[],
): [number, number, number, number] {
  if (totals.length === 0) return [1, 2, 3, 4];
  const sorted = [...totals].sort((a, b) => a - b);
  const q = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return [q(0.20), q(0.45), q(0.70), q(0.90)];
}

export function resolveCorridorBucket(
  workers: number,
  breaks: [number, number, number, number],
): CorridorBucket {
  if (workers < breaks[0]) return 1;
  if (workers < breaks[1]) return 2;
  if (workers < breaks[2]) return 3;
  if (workers < breaks[3]) return 4;
  return 5;
}

export function corridorStyle(
  workers: number,
  breaks: [number, number, number, number],
  isDashed = false,
): CorridorStyle {
  let bucket = resolveCorridorBucket(workers, breaks);
  // Dashed (ALL_OTHER-bound) corridors floor at bucket 2 — bucket 1 dashed
  // strokes drop below visibility on projector screens.
  if (isDashed && bucket === 1) bucket = 2;
  return { bucket, ...BUCKET_STYLES[bucket] };
}

export const CORRIDOR_BUCKET_STYLES = BUCKET_STYLES;

export const CORRIDOR_BUCKET_SEMANTIC: Record<CorridorBucket, string> = {
  1: 'quiet',
  2: 'secondary',
  3: 'regional',
  4: 'major',
  5: 'headline',
};
