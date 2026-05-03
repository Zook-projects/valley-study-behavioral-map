// App — thin shell that switches between dataset views. Each view (commute
// or visitors) is a fully independent React subtree with its own state, data
// loaders, and component graph. App owns the dataset selection and threads
// it (plus the setter) into each view so the view can render the
// DatasetToggle inside its own map area — this keeps the toggle anchored
// to the map on mobile (where the dashboard tile would otherwise overlap a
// fixed-to-viewport toggle).

import { useState } from 'react';
import { CommuteView } from './views/CommuteView';
import { VisitorView } from './views/VisitorView';
import type { Dataset } from './types/dataset';

export default function App() {
  const [dataset, setDataset] = useState<Dataset>('commute');

  return dataset === 'commute' ? (
    <CommuteView dataset={dataset} onDatasetChange={setDataset} />
  ) : (
    <VisitorView dataset={dataset} onDatasetChange={setDataset} />
  );
}
