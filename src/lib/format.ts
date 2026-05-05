// Number / percentage formatters.

const intFmt = new Intl.NumberFormat('en-US');
const pctFmt = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const fmtInt = (n: number) => intFmt.format(Math.round(n));
export const fmtPct = (p: number) => pctFmt.format(p);

// Compact USD label for axis-end annotations and headline figures: $1.2B,
// $850M, $42K. Used by both the Commerce comparison bars and the Commerce
// timeseries chart so axis tick labels read consistently across the section.
export function fmtCompactUSD(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${fmtInt(n)}`;
}
