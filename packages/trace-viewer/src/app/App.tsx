import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from './api/client';
import { FilterGroupBar } from './components/FilterGroupBar';
import { RunDetail } from './components/RunDetail';
import { RunTree } from './components/RunTree';
import { SettingsModal } from './components/SettingsModal';
import { type LayoutFocus, Toolbar } from './components/Toolbar';
import { TraceHeader } from './components/TraceHeader';
import { TraceSidebar } from './components/TraceSidebar';
import type { FilterGroup } from './lib/filter-groups';
import { loadFilterGroups, saveFilterGroups } from './lib/filter-groups';
import { applyRunTreeDisplayFilter } from './lib/run-tree-display-filter';
import {
  collectPayloadRefsFromTree,
  getTraceProfile,
  isFullTracePayloadsLoaded,
  type TraceProfileId,
} from './lib/trace-profiles';
import { cx, findRun, getTraceEnv, matchesTraceFilters, uniqueSorted } from './lib/viewer';
import type { ViewerSettings } from './lib/viewer-settings';
import {
  loadViewerSettings,
  normalizeViewerSettings,
  presetToIntervalMs,
  saveViewerSettings,
} from './lib/viewer-settings';
import type { RunNode, TraceFilters, TraceRow, TraceTree } from './types';

const defaultFilters: TraceFilters = {
  env: '',
  status: '',
  projectId: '',
  query: '',
};

export function App(): ReactNode {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [filters, setFilters] = useState<TraceFilters>(defaultFilters);
  const [tree, setTree] = useState<TraceTree | null>(null);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [payloadCache, setPayloadCache] = useState<Record<string, unknown>>({});
  const [payloadLoading, setPayloadLoading] = useState<string | null>(null);
  const [tracePayloadBatchLoading, setTracePayloadBatchLoading] = useState(false);
  const batchInFlightRef = useRef(false);
  const [layoutFocus, setLayoutFocus] = useState<LayoutFocus>('run-tree');
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>(() => loadFilterGroups());
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>(() => loadViewerSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const autoLoad = viewerSettings.autoLoad;

  useEffect(() => {
    saveViewerSettings(viewerSettings);
  }, [viewerSettings]);

  useEffect(() => {
    saveFilterGroups(filterGroups);
  }, [filterGroups]);

  // Clear cached payloads when switching traces (refs are not stable across traces).
  // biome-ignore lint/correctness/useExhaustiveDependencies: must run when `traceId` changes
  useEffect(() => {
    setPayloadCache({});
  }, [traceId]);

  const fetchTraces = useCallback(async () => {
    try {
      const r = await client.traces.list.query({});
      setTraces(r.traces as TraceRow[]);
      setListErr(null);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void fetchTraces();
  }, [fetchTraces]);

  useEffect(() => {
    const ms = presetToIntervalMs(viewerSettings.autoUpdatePreset);
    if (ms == null) return;
    const id = window.setInterval(() => {
      void fetchTraces();
    }, ms);
    return () => window.clearInterval(id);
  }, [viewerSettings.autoUpdatePreset, fetchTraces]);

  const filteredTraces = useMemo(
    () => traces.filter((trace) => matchesTraceFilters(trace, filters)),
    [filters, traces],
  );
  const envOptions = useMemo(() => uniqueSorted(traces.map(getTraceEnv)), [traces]);
  const statusOptions = useMemo(() => uniqueSorted(traces.map((trace) => trace.status)), [traces]);
  const projectOptions = useMemo(
    () => uniqueSorted(traces.map((trace) => trace.projectId ?? '')),
    [traces],
  );

  useEffect(() => {
    if (!traceId) return;
    if (filteredTraces.some((trace) => trace.traceId === traceId)) return;
    setTraceId(null);
    setTree(null);
    setRunId(null);
  }, [filteredTraces, traceId]);

  useEffect(() => {
    if (!traceId) {
      setTree(null);
      setRunId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await client.traces.getTree.query({ traceId });
        if (cancelled) return;
        if (!r) {
          setTree(null);
          setTreeErr('Trace not found');
          return;
        }
        setTree({ trace: r.trace as TraceRow, root: r.root as RunNode });
        setTreeErr(null);
        setRunId(r.root.runId);
      } catch (e) {
        if (cancelled) return;
        setTreeErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  const selectedRun = useMemo(() => {
    if (!tree || !runId) return null;
    return findRun(tree.root, runId);
  }, [tree, runId]);

  const runTreeDisplay = useMemo(() => {
    if (!tree) return null;
    return applyRunTreeDisplayFilter(tree.root, filterGroups);
  }, [tree, filterGroups]);

  const loadPayload = useCallback(async (ref: string) => {
    setPayloadLoading(ref);
    try {
      const data = await client.traces.getPayload.query({ ref });
      setPayloadCache((prev) => ({ ...prev, [ref]: data }));
    } finally {
      setPayloadLoading(null);
    }
  }, []);

  const loadManyPayloads = useCallback(async (refs: string[]) => {
    const unique = [...new Set(refs.filter(Boolean))];
    if (unique.length === 0) return;
    if (batchInFlightRef.current) return;
    batchInFlightRef.current = true;
    setTracePayloadBatchLoading(true);
    try {
      const entries = await Promise.all(
        unique.map(async (ref) => {
          const data = await client.traces.getPayload.query({ ref });
          return [ref, data] as const;
        }),
      );
      setPayloadCache((prev) => {
        const next = { ...prev };
        for (const [ref, data] of entries) {
          next[ref] = data;
        }
        return next;
      });
    } finally {
      setTracePayloadBatchLoading(false);
      batchInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!autoLoad || !selectedRun) return;
    const refs = [selectedRun.inputRef, selectedRun.outputRef].filter((ref): ref is string =>
      Boolean(ref),
    );
    const missingRef = refs.find((ref) => payloadCache[ref] === undefined);
    if (!missingRef || payloadLoading === missingRef) return;
    void loadPayload(missingRef);
  }, [autoLoad, loadPayload, payloadCache, payloadLoading, selectedRun]);

  const selectedProfile = useMemo(
    () => getTraceProfile(viewerSettings.activeTraceProfileId),
    [viewerSettings.activeTraceProfileId],
  );

  const profileTabs = useMemo(() => {
    return viewerSettings.enabledTraceProfileIds.map((id) => ({
      id,
      label: getTraceProfile(id).label,
    }));
  }, [viewerSettings.enabledTraceProfileIds]);

  const missingTracePayloadRefs = useMemo(() => {
    if (!tree) return [];
    return collectPayloadRefsFromTree(tree.root).filter((ref) => payloadCache[ref] === undefined);
  }, [tree, payloadCache]);

  const fullTracePayloadsLoaded = useMemo(
    () => (tree ? isFullTracePayloadsLoaded(tree.root, payloadCache) : false),
    [tree, payloadCache],
  );

  const aggregateContext = useMemo(() => {
    if (!tree) {
      return null;
    }
    return {
      trace: tree.trace,
      root: tree.root,
      payloadCache,
      fullTracePayloadsLoaded,
    };
  }, [tree, payloadCache, fullTracePayloadsLoaded]);

  const aggregates = useMemo(() => {
    if (!aggregateContext) {
      return { cards: [] as { id: string; label: string; value: string }[] };
    }
    return selectedProfile.buildAggregates(aggregateContext);
  }, [aggregateContext, selectedProfile]);

  useEffect(() => {
    if (!autoLoad || !tree) return;
    const profile = getTraceProfile(viewerSettings.activeTraceProfileId);
    if (!profile.requiresFullPayloads) return;
    const missing = collectPayloadRefsFromTree(tree.root).filter(
      (ref) => payloadCache[ref] === undefined,
    );
    if (missing.length === 0) return;
    void loadManyPayloads(missing);
  }, [autoLoad, loadManyPayloads, payloadCache, tree, viewerSettings.activeTraceProfileId]);

  const handleProfileChange = useCallback((id: TraceProfileId) => {
    setViewerSettings((prev) => normalizeViewerSettings({ ...prev, activeTraceProfileId: id }));
  }, []);

  const handleLoadTracePayloads = useCallback(() => {
    void loadManyPayloads(missingTracePayloadRefs);
  }, [loadManyPayloads, missingTracePayloadRefs]);

  return (
    <div
      className={cx(
        'grid h-screen grid-rows-[3rem_minmax(5rem,auto)_minmax(0,1fr)] overflow-hidden bg-zinc-950 text-zinc-200',
        layoutFocus === 'run-tree'
          ? 'grid-cols-[320px_minmax(0,1.35fr)_minmax(280px,0.65fr)]'
          : 'grid-cols-[320px_minmax(280px,0.65fr)_minmax(0,1.35fr)]',
      )}
    >
      <div className="col-span-3 col-start-1 row-start-1">
        <Toolbar
          layoutFocus={layoutFocus}
          onLayoutFocusChange={setLayoutFocus}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
      <TraceSidebar
        traces={filteredTraces}
        allTraceCount={traces.length}
        selectedTraceId={traceId}
        filters={filters}
        envOptions={envOptions}
        statusOptions={statusOptions}
        projectOptions={projectOptions}
        listErr={listErr}
        onFiltersChange={setFilters}
        onSelectTrace={setTraceId}
      />
      {!tree && (
        <div className="col-span-2 col-start-2 row-span-2 row-start-2 h-[calc(100vh-3rem)] overflow-auto bg-zinc-900 p-6 text-zinc-400">
          {treeErr ?? 'Select a trace to inspect runs and payloads.'}
        </div>
      )}
      {tree && (
        <>
          <div className="col-span-2 col-start-2 row-start-2 min-h-0 min-w-0">
            <TraceHeader
              trace={tree.trace}
              profileTabs={profileTabs}
              activeProfileId={viewerSettings.activeTraceProfileId}
              onProfileChange={handleProfileChange}
              aggregates={aggregates}
              missingTracePayloadCount={missingTracePayloadRefs.length}
              autoLoad={autoLoad}
              tracePayloadBatchLoading={tracePayloadBatchLoading}
              onLoadTracePayloads={handleLoadTracePayloads}
              showTracePayloadControls={selectedProfile.requiresFullPayloads}
            />
          </div>
          <section className="col-start-2 row-start-3 h-full min-h-0 min-w-0 overflow-auto border-r border-zinc-800 bg-zinc-900 p-4">
            <FilterGroupBar groups={filterGroups} onGroupsChange={setFilterGroups} />
            <div className="mb-3 font-semibold text-zinc-200">Run tree</div>
            {treeErr && <div className="text-red-400">{treeErr}</div>}
            {runTreeDisplay?.root ? (
              <RunTree
                node={runTreeDisplay.root}
                selectedId={runId}
                onSelect={setRunId}
                filterGroups={filterGroups}
                depthByRunId={runTreeDisplay.depthByRunId}
                hideBypassRunIds={runTreeDisplay.hideBypassRunIds}
              />
            ) : (
              <div className="text-sm text-zinc-500">
                No runs visible with the current hide filters.
              </div>
            )}
          </section>
          <RunDetail
            run={selectedRun}
            profile={selectedProfile}
            payloadCache={payloadCache}
            payloadLoading={payloadLoading}
            onLoadPayload={loadPayload}
          />
        </>
      )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={viewerSettings}
        onSettingsChange={(next) => setViewerSettings(normalizeViewerSettings(next))}
      />
    </div>
  );
}
