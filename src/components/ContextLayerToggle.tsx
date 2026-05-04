// ContextLayerToggle — segmented two-button pill control. Floats above the
// bottom card strip in the bottom-left corner of the map (positioned by
// CommuteView). Switches between the Commuters layer (LEHD flow cards) and
// the Demographics layer (regional context cards).

export type CardLayer = 'commute' | 'context';

interface Props {
  layer: CardLayer;
  onLayerChange: (l: CardLayer) => void;
}

function PillButton({
  active,
  onClick,
  children,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className="rounded px-2.5 py-1 text-[11px] tnum transition-colors"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-h)',
        background: active ? 'rgba(245, 158, 11, 0.16)' : 'transparent',
      }}
    >
      {children}
    </button>
  );
}

export function ContextLayerToggle({ layer, onLayerChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Card layer"
      className="glass rounded-md p-1 inline-flex items-center gap-1"
    >
      <PillButton
        active={layer === 'commute'}
        onClick={() => onLayerChange('commute')}
        ariaLabel="Show Commuters layer"
      >
        Commuters
      </PillButton>
      <PillButton
        active={layer === 'context'}
        onClick={() => onLayerChange('context')}
        ariaLabel="Show Demographics layer"
      >
        Demographics
      </PillButton>
    </div>
  );
}
