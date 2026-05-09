import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { client } from './api/client';
import { FilterGroupBar } from './components/FilterGroupBar';
import { RunDetail } from './components/RunDetail';
import { RunTree } from './components/RunTree';
import { type LayoutFocus, Toolbar } from './components/Toolbar';
import { TraceHeader } from './components/TraceHeader';
import { TraceSidebar } from './components/TraceSidebar';
import type { FilterGroup } from './lib/filter-groups';
import { loadFilterGroups, saveFilterGroups } from './lib/filter-groups';
import { applyRunTreeDisplayFilter } from './lib/run-tree-display-filter';
import { cx, findRun, getTraceEnv, matchesTraceFilters, uniqueSorted } from './lib/viewer';
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
  const [autoLoad, setAutoLoad] = useState(false);
  const [layoutFocus, setLayoutFocus] = useState<LayoutFocus>('run-tree');
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>(() => loadFilterGroups());

  useEffect(() => {
    saveFilterGroups(filterGroups);
  }, [filterGroups]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await client.traces.list.query({});
        if (cancelled) return;
        setTraces(r.traces as TraceRow[]);
        setListErr(null);
      } catch (e) {
        if (cancelled) return;
        setListErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    if (!autoLoad || !selectedRun) return;
    const refs = [selectedRun.inputRef, selectedRun.outputRef].filter((ref): ref is string =>
      Boolean(ref),
    );
    const missingRef = refs.find((ref) => payloadCache[ref] === undefined);
    if (!missingRef || payloadLoading === missingRef) return;
    void loadPayload(missingRef);
  }, [autoLoad, loadPayload, payloadCache, payloadLoading, selectedRun]);

  return (
    <div
      className={cx(
        'grid h-screen grid-rows-[3rem_5rem_minmax(0,1fr)] overflow-hidden bg-zinc-950 text-zinc-200',
        layoutFocus === 'run-tree'
          ? 'grid-cols-[320px_minmax(0,1.35fr)_minmax(280px,0.65fr)]'
          : 'grid-cols-[320px_minmax(280px,0.65fr)_minmax(0,1.35fr)]',
      )}
    >
      <div className="col-span-3 col-start-1 row-start-1">
        <Toolbar
          autoLoad={autoLoad}
          layoutFocus={layoutFocus}
          onAutoLoadChange={setAutoLoad}
          onLayoutFocusChange={setLayoutFocus}
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
          <div className="col-span-2 col-start-2 row-start-2 min-w-0">
            <TraceHeader trace={tree.trace} />
          </div>
          <section className="col-start-2 row-start-3 h-[calc(100vh-8rem)] min-w-0 overflow-auto border-r border-zinc-800 bg-zinc-900 p-4">
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
            payloadCache={payloadCache}
            payloadLoading={payloadLoading}
            onLoadPayload={loadPayload}
          />
        </>
      )}
    </div>
  );
}
