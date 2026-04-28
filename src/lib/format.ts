// Number / percentage formatters.

const intFmt = new Intl.NumberFormat('en-US');
const pctFmt = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const fmtInt = (n: number) => intFmt.format(Math.round(n));
export const fmtPct = (p: number) => pctFmt.format(p);
