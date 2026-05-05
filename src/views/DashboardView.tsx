// DashboardView — sibling to CommuteView. Surfaces the same LEHD LODES
// dataset as a traditional data view (workforce stats, sortable tables,
// charts) plus the regional context bundle, broken out into topical
// sections (demographics, commerce, housing).
//
// Layout: a sticky left menu lists the four sections (Workforce,
// Demographics, Commerce, Housing) and docks the filter group (Mode,
// Direction, ZIP) at its bottom. The main column scrolls all four
// sections; clicking a menu item smooth-scrolls to that section, and an
// IntersectionObserver highlights the section nearest the menu's
// anchor line as the user scrolls.
//
// Map-only chrome (heatmap, view-layer toggle, hover/pinned tooltips,
// pass-through cross-filter) is intentionally absent — those are spatial
// metaphors with no analogue in a tabular view.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DirectionFilter,
  FlowRow,
  Mode,
  SegmentFilter,
} from '../types/flow';
import {
  applySegmentFilter,
  filterByDirection,
  filterForSelection,
  isAnchorZip,
} from '../lib/flowQueries';
import { buildVisibleCorridorMap } from '../lib/corridors';
import type { FlowData } from '../lib/useFlowData';

import { ModeToggle } from '../components/ModeToggle';
import { DirectionToggle } from '../components/DirectionToggle';
import { ZipSelector } from '../components/ZipSelector';
import { StatsAggregated } from '../components/StatsAggregated';
import { StatsForZip } from '../components/StatsForZip';
import { ContextCards, type CommerceVariant, type CommerceCadence } from '../components/ContextCards';
import { CommerceComparisons } from '../components/CommerceComparisons';
import {
  BottomCardStrip,
  CardsForOd,
  perZipBlocks,
} from '../components/BottomCardStrip';
import { FlowDataTables } from '../components/dashboard/FlowDataTables';
import { HousingMarketSection } from '../components/dashboard/HousingMarketSection';

interface Props {
  data: FlowData;
}

type SectionId = 'workforce' | 'demographics' | 'commerce' | 'housing';

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'workforce', label: 'Workforce' },
  { id: 'demographics', label: 'Demographics' },
  { id: 'commerce', label: 'Commerce' },
  { id: 'housing', label: 'Housing' },
];

export function DashboardView({ data }: Props) {
  const {
    flowsInbound,
    flowsOutbound,
    flowsRegional,
    zips,
    corridorIndex,
    flowIndex,
    racFile,
    wacFile,
    odSummary,
    driveDistance,
    passThrough,
    contextBundle,
  } = data;

  // ----- Filter state (independent of CommuteView) ------------------------
  const [mode, setMode] = useState<Mode>('inbound');
  const [selectedZip, setSelectedZip] = useState<string | null>(null);
  const [nonAnchorBundle, setNonAnchorBundle] =
    useState<{ place: string; zips: string[] } | null>(null);
  const [selectedPartner, setSelectedPartner] =
    useState<{ place: string; zips: string[] } | null>(null);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [segmentFilter, setSegmentFilter] = useState<SegmentFilter>({
    axis: 'all',
    buckets: [],
  });

  // Active menu item — driven by the IntersectionObserver below. Clicking
  // a menu item also sets this directly so the highlight responds before
  // the scroll has finished.
  const [activeSection, setActiveSection] = useState<SectionId>('workforce');

  // Commerce section state — lifted here so the Commerce card and the
  // CommerceComparisons bar charts share a single variant + cadence
  // selection. Defaults: gross sales (broadest "business throughput"
  // metric) and annual cadence (cleaner trend lines).
  const [commerceVariant, setCommerceVariant] = useState<CommerceVariant>('gross');
  const [commerceCadence, setCommerceCadence] = useState<CommerceCadence>('annual');

  // ----- Derived state (mirrors the relevant parts of CommuteView) --------
  const selectionKind: 'aggregate' | 'anchor' | 'non-anchor' = useMemo(() => {
    if (!selectedZip || selectedZip === 'ALL_OTHER') return 'aggregate';
    return isAnchorZip(selectedZip) ? 'anchor' : 'non-anchor';
  }, [selectedZip]);

  // effectiveMode = 'regional' when no anchor is selected; otherwise the
  // user's chosen mode. Mirrors CommuteView's logic.
  const effectiveMode: Mode =
    !selectedZip || selectedZip === 'ALL_OTHER' ? 'regional' : mode;

  const flows: FlowRow[] =
    effectiveMode === 'regional'
      ? flowsRegional
      : effectiveMode === 'inbound'
      ? flowsInbound
      : flowsOutbound;

  const directionFilteredInbound = useMemo(
    () =>
      applySegmentFilter(
        filterByDirection(flowsInbound, zips, directionFilter),
        segmentFilter,
      ),
    [flowsInbound, zips, directionFilter, segmentFilter],
  );
  const directionFilteredOutbound = useMemo(
    () =>
      applySegmentFilter(
        filterByDirection(flowsOutbound, zips, directionFilter),
        segmentFilter,
      ),
    [flowsOutbound, zips, directionFilter, segmentFilter],
  );
  const directionFilteredRegional = useMemo(
    () =>
      applySegmentFilter(
        filterByDirection(flowsRegional, zips, directionFilter),
        segmentFilter,
      ),
    [flowsRegional, zips, directionFilter, segmentFilter],
  );
  const directionFilteredFlows =
    effectiveMode === 'regional'
      ? directionFilteredRegional
      : effectiveMode === 'inbound'
      ? directionFilteredInbound
      : directionFilteredOutbound;

  const visibleFlows = useMemo(
    () => filterForSelection(directionFilteredFlows, selectedZip, effectiveMode),
    [directionFilteredFlows, selectedZip, effectiveMode],
  );

  // Top-corridor headlines for both modes — passed to StatsAggregated.
  const topCorridorInbound = useMemo<{ label: string; total: number } | null>(() => {
    let best: { label: string; total: number } | null = null;
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, directionFilteredInbound, 'inbound');
    for (const agg of map.values()) {
      if (!best || agg.total > best.total) best = { label: agg.corridor.label, total: agg.total };
    }
    return best;
  }, [corridorIndex, flowIndex, directionFilteredInbound]);
  const topCorridorOutbound = useMemo<{ label: string; total: number } | null>(() => {
    let best: { label: string; total: number } | null = null;
    const map = buildVisibleCorridorMap(corridorIndex, flowIndex, directionFilteredOutbound, 'outbound');
    for (const agg of map.values()) {
      if (!best || agg.total > best.total) best = { label: agg.corridor.label, total: agg.total };
    }
    return best;
  }, [corridorIndex, flowIndex, directionFilteredOutbound]);

  // ----- Per-zip block lookup --------------------------------------------
  // Mirrors BottomCardStrip's internal lookup so the WorkplaceMetricsCard
  // can render inline in the Workforce section's left column. Only active
  // when an anchor ZIP is selected.
  const racEntry = useMemo(
    () =>
      selectedZip && selectionKind === 'anchor'
        ? racFile.entries.find((e) => e.zip === selectedZip) ?? null
        : null,
    [selectedZip, selectionKind, racFile],
  );
  const wacEntry = useMemo(
    () =>
      selectedZip && selectionKind === 'anchor'
        ? wacFile.entries.find((e) => e.zip === selectedZip) ?? null
        : null,
    [selectedZip, selectionKind, wacFile],
  );
  const odEntry = useMemo(
    () =>
      selectedZip && selectionKind === 'anchor'
        ? odSummary.entries.find((e) => e.zip === selectedZip) ?? null
        : null,
    [selectedZip, selectionKind, odSummary],
  );
  const perZipBlockData = useMemo(
    () =>
      selectionKind === 'anchor'
        ? perZipBlocks(racEntry, wacEntry, odEntry, segmentFilter)
        : null,
    [selectionKind, racEntry, wacEntry, odEntry, segmentFilter],
  );
  const anchorScope = useMemo(() => {
    if (selectionKind !== 'anchor' || !selectedZip) return '';
    return (
      odEntry?.place ||
      racEntry?.place ||
      wacEntry?.place ||
      zips.find((z) => z.zip === selectedZip)?.place ||
      selectedZip
    );
  }, [selectionKind, selectedZip, odEntry, racEntry, wacEntry, zips]);
  // ----- Handlers ---------------------------------------------------------
  const handleSelectZip = (z: string | null) => {
    setSelectedZip(z);
    setSelectedPartner(null);
    if (!z || z === 'ALL_OTHER' || isAnchorZip(z)) {
      setNonAnchorBundle(null);
      return;
    }
    const meta = zips.find((x) => x.zip === z);
    if (!meta) {
      setNonAnchorBundle(null);
      return;
    }
    const place = meta.place;
    const siblingZips = zips
      .filter((x) => x.place === place && !x.isSynthetic)
      .map((x) => x.zip)
      .sort();
    setNonAnchorBundle({ place, zips: siblingZips.length ? siblingZips : [z] });
    setMode('inbound');
  };

  const handleResetSelection = () => handleSelectZip(null);

  // ----- Section refs + scroll-spy ----------------------------------------
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    workforce: null,
    demographics: null,
    commerce: null,
    housing: null,
  });

  // IntersectionObserver — highlights whichever section's top is closest
  // to the top of the scroll container. Threshold list at every 10% lets
  // us pick the section with the largest visible ratio at any moment.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry whose top is closest to (and at-or-above) the
        // root's top. Falls back to the most-visible entry otherwise.
        let best: { id: SectionId; ratio: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).id as SectionId;
          if (!id) continue;
          if (!best || e.intersectionRatio > best.ratio) {
            best = { id, ratio: e.intersectionRatio };
          }
        }
        if (best) setActiveSection(best.id);
      },
      {
        root,
        // Trigger when a section's top crosses ~64px below the top of
        // the scroll container; bottom margin pulls earlier so a section
        // is "active" once its header has scrolled into view.
        rootMargin: '-64px 0px -50% 0px',
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      },
    );
    for (const id of Object.keys(sectionRefs.current) as SectionId[]) {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const handleMenuClick = (id: SectionId) => {
    setActiveSection(id);
    const el = sectionRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const setSectionRef = (id: SectionId) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  };

  // ----- Layout -----------------------------------------------------------
  return (
    <div
      className="w-full flex-1 flex flex-col md:flex-row md:min-h-0"
      style={{ background: 'var(--bg-base)' }}
    >
      {/* Left menu — sticky on desktop, collapses to a horizontal chip
          row + stacked filter group on mobile. */}
      <aside
        className="glass relative z-10 flex flex-col md:w-[240px] md:shrink-0 md:h-[calc(100vh-2.5rem)] md:sticky md:top-10 md:overflow-y-auto"
        style={{ borderRight: '1px solid var(--panel-border)' }}
      >
        <nav
          className="px-2 py-2 md:py-3 flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible"
          aria-label="Dashboard sections"
        >
          {SECTIONS.map((s) => {
            const active = s.id === activeSection;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => handleMenuClick(s.id)}
                aria-current={active ? 'true' : undefined}
                className="text-left px-3 py-2 rounded-md text-[11px] font-medium uppercase tracking-wider transition-colors shrink-0 focus:outline-none focus-visible:ring-1"
                style={{
                  color: active ? 'var(--accent)' : 'var(--text-h)',
                  background: active ? 'rgba(245, 158, 11, 0.16)' : 'transparent',
                  border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
                }}
              >
                {s.label}
              </button>
            );
          })}
        </nav>

        {/* Filter group — docked at the bottom of the menu on desktop,
            stacked below the chips on mobile. Hosts the same Mode /
            Direction / ZIP controls that previously lived in the sticky
            top filter header. */}
        <div
          className="md:mt-auto px-3 py-3 flex flex-col gap-3 border-t md:border-t"
          style={{ borderColor: 'var(--panel-border)' }}
        >
          <div
            className="text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Filters
          </div>
          <ModeToggle
            mode={mode}
            onChange={setMode}
            disabled={selectionKind === 'non-anchor'}
            aggregate={selectionKind === 'aggregate'}
          />
          <DirectionToggle
            value={directionFilter}
            onChange={setDirectionFilter}
          />
          <ZipSelector
            zips={zips}
            selectedZip={selectedZip}
            onSelectZip={handleSelectZip}
          />
        </div>
      </aside>

      {/* Main scrolling content. */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 md:overflow-y-auto"
      >
        <div className="px-3 md:px-4 py-4 flex flex-col gap-4 max-w-[1400px] mx-auto">
          {/* Section — Workforce. Existing Workforce, Jobs & OD Flows panel
              + RAC/WAC strip + Flow Data tables, all under one menu item
              per spec. */}
          <section
            id="workforce"
            ref={setSectionRef('workforce')}
            className="scroll-mt-4 flex flex-col gap-4"
          >
            <div
              className="rounded-md p-3"
              style={{
                background: 'var(--panel-surface)',
                border: '1px solid var(--panel-border)',
              }}
            >
              <h2
                className="text-[10px] font-semibold uppercase tracking-wider mb-3"
                style={{ color: 'var(--text-dim)' }}
              >
                Workforce, Jobs &amp; OD Flows
              </h2>
              {selectedZip == null || selectedZip === 'ALL_OTHER' ? (
                <StatsAggregated
                  flowsInbound={flowsInbound}
                  flowsOutbound={flowsOutbound}
                  directionFilteredInbound={directionFilteredInbound}
                  directionFilteredOutbound={directionFilteredOutbound}
                  directionFilter={directionFilter}
                  topCorridorInbound={topCorridorInbound}
                  topCorridorOutbound={topCorridorOutbound}
                  zips={zips}
                  driveDistance={driveDistance}
                  layout="side-by-side"
                  defaultExpanded
                />
              ) : selectionKind === 'anchor' && perZipBlockData ? (
                // Anchor view: 1/3 left column (totals + Workforce flows OD chart)
                // + 2/3 right column (Top inflow + Top outflow side by side).
                // The Workplace Metrics card now lives in the BottomCardStrip
                // below alongside the other anchor cards. The grid items
                // stretch to equal heights, and the left column's CardsForOd
                // grows to fill the gap between the (short) totals tiles and
                // the (taller) right-column lists.
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
                  <div className="md:col-span-1 flex flex-col gap-3 min-h-0">
                    <StatsForZip
                      flows={flows}
                      directionFilteredFlows={directionFilteredFlows}
                      flowsInbound={flowsInbound}
                      flowsOutbound={flowsOutbound}
                      directionFilteredInbound={directionFilteredInbound}
                      directionFilteredOutbound={directionFilteredOutbound}
                      directionFilter={directionFilter}
                      zips={zips}
                      selectedZip={selectedZip}
                      selectionKind={selectionKind}
                      nonAnchorBundle={nonAnchorBundle}
                      visibleFlows={visibleFlows}
                      bundleFlows={[]}
                      mode={mode}
                      selectedPartner={selectedPartner}
                      onSelectPartner={setSelectedPartner}
                      onReset={handleResetSelection}
                      slot="tiles"
                    />
                    <div className="flex-1 min-h-0 flex flex-col">
                      <CardsForOd
                        scope={anchorScope}
                        inflowLatest={perZipBlockData.inflowLatest}
                        inflowTrend={perZipBlockData.inflowTrend}
                        outflowLatest={perZipBlockData.outflowLatest}
                        outflowTrend={perZipBlockData.outflowTrend}
                        withinLatest={perZipBlockData.withinLatest}
                        withinTrend={perZipBlockData.withinTrend}
                        width="100%"
                        minChartHeight={220}
                      />
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <StatsForZip
                      flows={flows}
                      directionFilteredFlows={directionFilteredFlows}
                      flowsInbound={flowsInbound}
                      flowsOutbound={flowsOutbound}
                      directionFilteredInbound={directionFilteredInbound}
                      directionFilteredOutbound={directionFilteredOutbound}
                      directionFilter={directionFilter}
                      zips={zips}
                      selectedZip={selectedZip}
                      selectionKind={selectionKind}
                      nonAnchorBundle={nonAnchorBundle}
                      visibleFlows={visibleFlows}
                      bundleFlows={[]}
                      mode={mode}
                      selectedPartner={selectedPartner}
                      onSelectPartner={setSelectedPartner}
                      onReset={handleResetSelection}
                      slot="lists"
                    />
                  </div>
                </div>
              ) : (
                <StatsForZip
                  flows={flows}
                  directionFilteredFlows={directionFilteredFlows}
                  flowsInbound={flowsInbound}
                  flowsOutbound={flowsOutbound}
                  directionFilteredInbound={directionFilteredInbound}
                  directionFilteredOutbound={directionFilteredOutbound}
                  directionFilter={directionFilter}
                  zips={zips}
                  selectedZip={selectedZip}
                  selectionKind={selectionKind}
                  nonAnchorBundle={nonAnchorBundle}
                  visibleFlows={visibleFlows}
                  bundleFlows={[]}
                  mode={mode}
                  selectedPartner={selectedPartner}
                  onSelectPartner={setSelectedPartner}
                  onReset={handleResetSelection}
                />
              )}

              {/* Workforce / RAC / WAC strip merged into the Workforce section.
                  BottomCardStrip is rendered with `inline` so its outer
                  wrapper flows normally instead of overlay-positioning at
                  the bottom of the map. The wrapping div sizes naturally
                  to the cards' row height — no min-height needed and no
                  growth pressure on the section above as the viewport
                  widens. */}
              <div
                className="mt-3 pt-3 border-t"
                style={{ borderColor: 'var(--rule)' }}
              >
                <BottomCardStrip
                  racFile={racFile}
                  wacFile={wacFile}
                  odSummary={odSummary}
                  selectedZip={selectedZip}
                  selectionKind={selectionKind}
                  nonAnchorBundle={nonAnchorBundle}
                  visibleFlows={visibleFlows}
                  bundleFlows={[]}
                  selectedPartner={selectedPartner}
                  mode={mode}
                  flowsInbound={directionFilteredInbound}
                  flowsOutbound={directionFilteredOutbound}
                  zips={zips}
                  corridorIndex={corridorIndex}
                  flowIndex={flowIndex}
                  driveDistance={driveDistance}
                  segmentFilter={segmentFilter}
                  onSegmentFilterChange={setSegmentFilter}
                  directionFilter={directionFilter}
                  passThrough={passThrough}
                  passThroughOrigin={null}
                  passThroughDest={null}
                  onPassThroughOriginChange={() => {}}
                  onPassThroughDestChange={() => {}}
                  cardLayer="commute"
                  contextBundle={contextBundle}
                  hidePartnerCards
                  hideOdFlows={selectionKind === 'anchor'}
                  hideSegmentFilter={selectionKind === 'aggregate'}
                  inline
                />
              </div>
            </div>

            {/* Flow data tables. */}
            <FlowDataTables
              flowsInbound={flowsInbound}
              flowsOutbound={flowsOutbound}
              flowsRegional={flowsRegional}
              activeFlows={directionFilteredFlows}
              zips={zips}
              corridorIndex={corridorIndex}
              flowIndex={flowIndex}
              mode={effectiveMode}
              selectedZip={selectedZip}
              onSelectZip={handleSelectZip}
              onSelectPartner={setSelectedPartner}
            />

          </section>

          {/* Section — Demographics: population + workforce flows + education. */}
          <section
            id="demographics"
            ref={setSectionRef('demographics')}
            className="scroll-mt-4 rounded-md p-3"
            style={{
              background: 'var(--panel-surface)',
              border: '1px solid var(--panel-border)',
            }}
          >
            <h2
              className="text-[10px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-dim)' }}
            >
              Demographics
            </h2>
            <div className="flex flex-wrap gap-3">
              <ContextCards
                bundle={contextBundle}
                selectedZip={selectedZip}
                racFile={racFile}
                wacFile={wacFile}
                odSummary={odSummary}
                topics={['demographics', 'employment', 'education']}
              />
            </div>
          </section>

          {/* Section — Commerce: headline card + three peer-comparison bar
              charts (counties, anchor places, place share of county). All
              four surfaces share the variant + cadence toggle lifted into
              DashboardView state. */}
          <section
            id="commerce"
            ref={setSectionRef('commerce')}
            className="scroll-mt-4 rounded-md p-3"
            style={{
              background: 'var(--panel-surface)',
              border: '1px solid var(--panel-border)',
            }}
          >
            <h2
              className="text-[10px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-dim)' }}
            >
              Commerce
            </h2>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <ContextCards
                  bundle={contextBundle}
                  selectedZip={selectedZip}
                  racFile={racFile}
                  wacFile={wacFile}
                  odSummary={odSummary}
                  topics={['commerce']}
                  commerceVariant={commerceVariant}
                  onCommerceVariantChange={setCommerceVariant}
                  commerceCadence={commerceCadence}
                  onCommerceCadenceChange={setCommerceCadence}
                />
              </div>
              <CommerceComparisons
                bundle={contextBundle}
                selectedZip={selectedZip}
                variant={commerceVariant}
              />
            </div>
          </section>

          {/* Section — Housing Market: full Zillow ZHVI panel (headline stats,
              time series, radar, type bars, city comparison filter). */}
          <section
            id="housing"
            ref={setSectionRef('housing')}
            className="scroll-mt-4 rounded-md p-3"
            style={{
              background: 'var(--panel-surface)',
              border: '1px solid var(--panel-border)',
            }}
          >
            <h2
              className="text-[10px] font-semibold uppercase tracking-wider mb-3"
              style={{ color: 'var(--text-dim)' }}
            >
              Housing Market
            </h2>
            <HousingMarketSection bundle={contextBundle} selectedZip={selectedZip} />
          </section>
        </div>
      </div>
    </div>
  );
}
