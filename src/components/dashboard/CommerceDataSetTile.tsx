// CommerceDataSetTile — anchors the left column of the Dashboard's Commerce
// section with a plain-language explanation of the underlying CDOR sales
// dataset and how to read the rest of the panel. Mirrors the visual
// language of the Housing section's HousingDataSetTile so the two sections
// feel parallel.

export function CommerceDataSetTile() {
  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--panel-border)',
      }}
    >
      <div>
        <div
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-h)' }}
        >
          About this data
        </div>
        <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
          Colorado Department of Revenue · Sales Tax Statistics
        </div>
      </div>
      <p className="text-[11px] leading-snug" style={{ color: 'var(--text)' }}>
        Three measures of merchant activity reported by point of sale.
        <strong className="font-semibold" style={{ color: 'var(--text-h)' }}> Gross Sales </strong>
        captures total business throughput;
        <strong className="font-semibold" style={{ color: 'var(--text-h)' }}> Retail Sales </strong>
        narrows to merchant-to-consumer transactions; and
        <strong className="font-semibold" style={{ color: 'var(--text-h)' }}> Net Taxable Sales </strong>
        is the state-tax base after exemptions. Reported monthly and rolled up to annual totals.
      </p>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1">
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Source
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>CDOR Retail Reports</span>
        </li>
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Geography
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>City / County / State</span>
        </li>
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Cadence
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>Monthly · annualized</span>
        </li>
        <li className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            Coverage
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-h)' }}>2016 → latest</span>
        </li>
      </ul>
    </div>
  );
}
