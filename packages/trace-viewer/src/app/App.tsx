import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { client } from './api/client';
import { RunDetail } from './components/RunDetail';
import { RunTree } from './components/RunTree';
import { Toolbar } from './components/Toolbar';
import { TraceHeader } from './components/TraceHeader';
import { TraceSidebar } from './components/TraceSidebar';
import { findRun, getTraceEnv, matchesTraceFilters, uniqueSorted } from './lib/viewer';
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
    <div className="flex min-h-screen bg-zinc-950 text-zinc-200">
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
      <main className="flex min-w-0 flex-1 flex-col bg-zinc-900">
        <Toolbar autoLoad={autoLoad} onAutoLoadChange={setAutoLoad} />
        {!tree && (
          <div className="p-6 text-zinc-400">
            {treeErr ?? 'Select a trace to inspect runs and payloads.'}
          </div>
        )}
        {tree && (
          <>
            <TraceHeader trace={tree.trace} />
            <div className="flex min-h-0 flex-1">
              <section className="min-w-0 flex-1 overflow-y-auto border-r border-zinc-800 p-4">
                <div className="mb-3 font-semibold text-zinc-200">Run tree</div>
                {treeErr && <div className="text-red-400">{treeErr}</div>}
                <RunTree node={tree.root} selectedId={runId} onSelect={setRunId} />
              </section>
              <RunDetail
                run={selectedRun}
                payloadCache={payloadCache}
                payloadLoading={payloadLoading}
                onLoadPayload={loadPayload}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
