// Replaces ModeToggle when a non-anchor place is selected. The inbound/
// outbound toggle isn't meaningful for non-anchor ZIPs — the LODES anchor
// dataset only tracks workers commuting INTO the 11 anchor workplaces, so
// any view scoped to a non-anchor place can only show that place's residents
// commuting to anchors. The notice explains the lock and offers a quick
// path back to the aggregate view (which restores the toggle).

interface Props {
  bundle: { place: string; zips: string[] };
  onClear: () => void;
}

export function NonAnchorNotice({ bundle, onClear }: Props) {
  const zipLabel =
    bundle.zips.length === 1 ? bundle.zips[0] : bundle.zips.join(' · ');
  return (
    <div
      className="rounded-lg border px-3 py-2 space-y-1.5"
      style={{
        background: 'var(--accent-soft, rgba(255,180,84,0.10))',
        borderColor: 'var(--accent)',
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--accent)' }}
      >
        Non-Anchor Place · Inbound Locked
      </div>
      <div className="text-[11px] leading-snug" style={{ color: 'var(--text-h)' }}>
        Viewing residents of <strong>{bundle.place}</strong>
        {bundle.zips.length > 1 ? (
          <>
            {' '}(<span style={{ color: 'var(--text-dim)' }}>ZIPs {zipLabel}</span>)
          </>
        ) : (
          <>
            {' '}(<span style={{ color: 'var(--text-dim)' }}>{zipLabel}</span>)
          </>
        )}
        {' '}commuting to the 11 workplace anchors.
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-[11px] underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
        style={{ color: 'var(--accent)' }}
      >
        ← Back to aggregate view
      </button>
    </div>
  );
}
