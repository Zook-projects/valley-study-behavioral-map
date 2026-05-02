// App — thin shell that switches between dataset views. Each view (commute
// or visitors) is a fully independent React subtree with its own state, data
// loaders, and component graph. The DatasetToggle floats in the top-left of
// the viewport so neither view has to make space for it in its own layout.

import { useState } from 'react';
import { CommuteView } from './views/CommuteView';
import { VisitorView } from './views/VisitorView';
import { DatasetToggle } from './components/DatasetToggle';
import type { Dataset } from './types/dataset';

export default function App() {
  const [dataset, setDataset] = useState<Dataset>('commute');

  return (
    <>
      {dataset === 'commute' ? <CommuteView /> : <VisitorView />}

      {/* Top-level dataset selector — pinned top-left of the MAP AREA on
          desktop (just inside from the right edge of the 380px dashboard
          tile). On mobile the dashboard tile is full-width on top, so the
          toggle falls back to the viewport top-left — that overlaps the
          dashboard but mobile is already space-constrained, and the
          alternative (anchoring to the bottom map area) is less reachable.
          z-index above the dashboard tile (z-10) and the active-filter
          chips (z-30) so it stays clickable across both views. */}
      <div className="fixed top-2 left-2 md:top-3 md:left-[396px] z-40">
        <DatasetToggle dataset={dataset} onChange={setDataset} />
      </div>
    </>
  );
}
