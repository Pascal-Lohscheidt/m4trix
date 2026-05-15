import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import {
  collectPayloadRefsFromTree,
  getTraceProfile,
  isFullTracePayloadsLoaded,
} from '../lib/trace-profiles';
import { buildSubtreeRollupsByRunId } from '../lib/trace-profiles/langgraph/aggregates';
import { applyRunTreeDisplayFilter } from '../lib/run-tree-display-filter';
import { findRun } from '../lib/viewer';
import { useFilterGroups } from '../state/filter-groups-context';
import { useViewerSettings } from '../state/viewer-settings-context';
import type { TraceTree } from '../types';
import { FilterGroupBar } from './FilterGroupBar';
import { RunDetail } from './RunDetail';
import { RunTree } from './RunTree';
import { TraceHeader } from './TraceHeader';

export type TraceMainPanelProps = {
  tree: TraceTree;
  treeErr: string | null;
  runId: string | null;
  setRunId: (id: string | null) => void;
  payloadCache: Record<string, unknown>;
  payloadLoading: string | null;
  tracePayloadBatchLoading: boolean;
  loadPayload: (ref: string) => void | Promise<void>;
  loadManyPayloads: (refs: string[]) => void | Promise<void>;
};

export function TraceMainPanel({
  tree,
  treeErr,
  runId,
  setRunId,
  payloadCache,
  payloadLoading,
  tracePayloadBatchLoading,
  loadPayload,
  loadManyPayloads,
}: TraceMainPanelProps): ReactNode {
  const { filterGroups } = useFilterGroups();
  const { settings, activeProfile: selectedProfile, autoLoad } = useViewerSettings();

  const selectedRun = useMemo(() => {
    if (!tree || !runId) return null;
    return findRun(tree.root, runId);
  }, [tree, runId]);

  const runTreeDisplay = useMemo(
    () => applyRunTreeDisplayFilter(tree.root, filterGroups),
    [tree.root, filterGroups],
  );

  useEffect(() => {
    if (!autoLoad || !selectedRun) return;
    const refs = [selectedRun.inputRef, selectedRun.outputRef].filter((ref): ref is string =>
      Boolean(ref),
    );
    const missingRef = refs.find((ref) => payloadCache[ref] === undefined);
    if (!missingRef || payloadLoading === missingRef) return;
    void loadPayload(missingRef);
  }, [autoLoad, loadPayload, payloadCache, payloadLoading, selectedRun]);

  const missingTracePayloadRefs = useMemo(() => {
    return collectPayloadRefsFromTree(tree.root).filter((ref) => payloadCache[ref] === undefined);
  }, [tree.root, payloadCache]);

  const fullTracePayloadsLoaded = useMemo(
    () => isFullTracePayloadsLoaded(tree.root, payloadCache),
    [tree.root, payloadCache],
  );

  const aggregateContext = useMemo(
    () => ({
      trace: tree.trace,
      root: tree.root,
      payloadCache,
      fullTracePayloadsLoaded,
    }),
    [tree.trace, tree.root, payloadCache, fullTracePayloadsLoaded],
  );

  const aggregates = useMemo(() => {
    return selectedProfile.buildAggregates(aggregateContext);
  }, [aggregateContext, selectedProfile]);

  const langgraphSubtreeRollups = useMemo(() => {
    if (selectedProfile.id !== 'langgraph') return null;
    return buildSubtreeRollupsByRunId(tree.root, payloadCache);
  }, [selectedProfile.id, tree.root, payloadCache]);

  useEffect(() => {
    if (!autoLoad || !tree) return;
    const profile = getTraceProfile(settings.activeTraceProfileId);
    if (!profile.requiresFullPayloads) return;
    const missing = collectPayloadRefsFromTree(tree.root).filter(
      (ref) => payloadCache[ref] === undefined,
    );
    if (missing.length === 0) return;
    void loadManyPayloads(missing);
  }, [autoLoad, loadManyPayloads, payloadCache, tree, settings.activeTraceProfileId]);

  const handleLoadTracePayloads = useCallback(() => {
    void loadManyPayloads(missingTracePayloadRefs);
  }, [loadManyPayloads, missingTracePayloadRefs]);

  return (
    <>
      <div className="col-span-2 col-start-2 row-start-2 min-h-0 min-w-0">
        <TraceHeader
          trace={tree.trace}
          aggregates={aggregates}
          missingTracePayloadCount={missingTracePayloadRefs.length}
          tracePayloadBatchLoading={tracePayloadBatchLoading}
          onLoadTracePayloads={handleLoadTracePayloads}
          showTracePayloadControls={selectedProfile.requiresFullPayloads}
        />
      </div>
      <section className="col-start-2 row-start-3 h-full min-h-0 min-w-0 overflow-auto border-r border-zinc-800 bg-zinc-900 p-4">
        <FilterGroupBar />
        <div className="mb-3 font-semibold text-zinc-200">Run tree</div>
        {treeErr && <div className="text-red-400">{treeErr}</div>}
        {runTreeDisplay.root ? (
          <RunTree
            node={runTreeDisplay.root}
            selectedId={runId}
            onSelect={setRunId}
            depthByRunId={runTreeDisplay.depthByRunId}
            hideBypassRunIds={runTreeDisplay.hideBypassRunIds}
            subtreeRollupsByRunId={langgraphSubtreeRollups ?? undefined}
            subtreeRollupsComplete={fullTracePayloadsLoaded}
          />
        ) : (
          <div className="text-sm text-zinc-500">No runs visible with the current hide filters.</div>
        )}
      </section>
      <RunDetail
        run={selectedRun}
        payloadCache={payloadCache}
        payloadLoading={payloadLoading}
        onLoadPayload={loadPayload}
      />
    </>
  );
}
