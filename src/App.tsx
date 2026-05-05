// App — top-level shell. Loads the LODES + corridor + context bundle once via
// useFlowData, then renders a TopBar that switches between the Map view (the
// existing CommuteView) and the new Dashboard view. The two views own their
// filter state independently — switching tabs is instant because the data
// lives above them, but each view starts fresh on its own filters.

import { useEffect, useState } from 'react';
import { CommuteView } from './views/CommuteView';
import { DashboardView } from './views/DashboardView';
import { TopBar, type AppView } from './components/TopBar';
import { useFlowData } from './lib/useFlowData';

const VIEW_KEY = 'valley-study-active-view';

function readInitialView(): AppView {
  if (typeof window === 'undefined') return 'map';
  const v = window.sessionStorage.getItem(VIEW_KEY);
  return v === 'dashboard' ? 'dashboard' : 'map';
}

export default function App() {
  const { data, isLoading, error } = useFlowData();
  const [view, setView] = useState<AppView>(() => readInitialView());

  // Persist tab selection across reloads. Session-scoped so different windows
  // can land on different tabs without leaking selection.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(VIEW_KEY, view);
    }
  }, [view]);

  if (error) {
    return (
      <div className="min-h-screen w-full md:w-screen md:h-screen flex items-center justify-center px-4">
        <div className="text-xs uppercase tracking-widest text-center" style={{ color: 'var(--text-dim)' }}>
          <div style={{ color: 'var(--accent)' }}>Data load failed</div>
          <div className="mt-2 normal-case">{error.message}</div>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="min-h-screen w-full md:w-screen md:h-screen flex items-center justify-center">
        <div className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
          Loading flow data…
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen w-full flex flex-col md:h-screen md:overflow-hidden"
      style={{ background: 'var(--bg-base)' }}
    >
      <TopBar view={view} onChange={setView} />
      {/* Each view is mounted only when active so its internal `useState`
          resets when the user toggles back, matching the "independent state"
          decision (a filter set on the Map doesn't follow into the Dashboard
          and vice versa). The flex-1 min-h-0 container gives both views the
          space below the TopBar; the Map view fills it (its own absolute
          inset-0 chrome), while the Dashboard scrolls its content. */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        {view === 'map' ? (
          <CommuteView data={data} />
        ) : (
          <DashboardView data={data} />
        )}
      </div>
    </div>
  );
}
