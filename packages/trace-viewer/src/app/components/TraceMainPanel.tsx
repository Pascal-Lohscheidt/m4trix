import { ChartBarHorizontalIcon, TreeViewIcon } from '@phosphor-icons/react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { collectPayloadRefsFromTree, isFullTracePayloadsLoaded } from '../lib/trace-profiles';
import { coverageForTree } from '../lib/payload-mapper/coverage';
import { applyRunTreeDisplayFilter } from '../lib/run-tree-display-filter';
import type { RunTreeView } from '../lib/url-state';
import { findRun } from '../lib/viewer';
import { computeTraceTimeline, timelineTicks } from '../lib/waterfall';
import { useFilterGroups } from '../state/filter-groups-context';
import { useViewerSettings } from '../state/viewer-settings-context';
import type { TraceTree } from '../types';
import { FilterGroupBar } from './FilterGroupBar';
import { RunDetail } from './RunDetail';
import { RunTree } from './RunTree';
import type { LayoutFocus } from './Toolbar';
import { TraceHeader } from './TraceHeader';
import { GlassCard } from './ui/GlassCard';
import { Segmented } from './ui/Segmented';
import { WaterfallAxis } from './WaterfallAxis';

export type TraceMainPanelProps = {
  tree: TraceTree;
  treeErr: string | null;
  runId: string | null;
  setRunId: (id: string | null) => void;
  view: RunTreeView;
  onViewChange: (view: RunTreeView) => void;
  layoutFocus: LayoutFocus;
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
  view,
  onViewChange,
  layoutFocus,
  payloadCache,
  payloadLoading,
  tracePayloadBatchLoading,
  loadPayload,
  loadManyPayloads,
}: TraceMainPanelProps): ReactNode {
  const { filterGroups } = useFilterGroups();
  const { activeProfile: selectedProfile, autoLoad } = useViewerSettings();

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

  // Axis covers the whole trace, so hiding plumbing never rescales the bars.
  const waterfall = useMemo(() => {
    const timeline = computeTraceTimeline(tree.root);
    if (!timeline) return null;
    const ticks = timelineTicks(timeline.spanMs);
    const gridStepPct =
      ticks.length > 1 && timeline.spanMs > 0 ? (ticks[1] / timeline.spanMs) * 100 : 25;
    return { timeline, ticks, gridStepPct };
  }, [tree.root]);
  const showWaterfall = view === 'waterfall' && waterfall != null;

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

  const customCoverage = useMemo(() => {
    const custom = selectedProfile.custom;
    if (!custom) return null;
    return {
      profileId: custom.profileId,
      report: coverageForTree(custom.mapping, tree.root, payloadCache),
    };
  }, [selectedProfile, tree.root, payloadCache]);

  const subtreeRollups = useMemo(
    () => selectedProfile.buildSubtreeRollups?.(tree.root, payloadCache) ?? null,
    [selectedProfile, tree.root, payloadCache],
  );

  useEffect(() => {
    if (!autoLoad || !tree) return;
    if (!selectedProfile.requiresFullPayloads) return;
    const missing = collectPayloadRefsFromTree(tree.root).filter(
      (ref) => payloadCache[ref] === undefined,
    );
    if (missing.length === 0) return;
    void loadManyPayloads(missing);
  }, [autoLoad, loadManyPayloads, payloadCache, tree, selectedProfile.requiresFullPayloads]);

  const handleLoadTracePayloads = useCallback(() => {
    void loadManyPayloads(missingTracePayloadRefs);
  }, [loadManyPayloads, missingTracePayloadRefs]);

  const runTreeCard = (
    <GlassCard
      key="tree"
      title="Runs"
      className="min-w-[300px]"
      actions={
        <Segmented<RunTreeView>
          legend="Run view"
          value={view}
          onChange={onViewChange}
          items={[
            {
              key: 'waterfall',
              title: 'Tree with a time bar per run',
              label: (
                <>
                  <ChartBarHorizontalIcon
                    aria-hidden="true"
                    weight="bold"
                    className="h-3.5 w-3.5"
                  />
                  Waterfall
                </>
              ),
            },
            {
              key: 'tree',
              title: 'Tree only, full run names',
              label: (
                <>
                  <TreeViewIcon aria-hidden="true" weight="bold" className="h-3.5 w-3.5" />
                  Tree
                </>
              ),
            },
          ]}
        />
      }
    >
      <FilterGroupBar />
      {treeErr && <div className="mb-2 text-sm text-rose-300">{treeErr}</div>}
      <div
        className="@container"
        style={
          waterfall
            ? ({ '--waterfall-grid-step': `${waterfall.gridStepPct}%` } as CSSProperties)
            : undefined
        }
      >
        {showWaterfall && <WaterfallAxis timeline={waterfall.timeline} ticks={waterfall.ticks} />}
        {runTreeDisplay.root ? (
          <RunTree
            node={runTreeDisplay.root}
            selectedId={runId}
            onSelect={setRunId}
            depthByRunId={runTreeDisplay.depthByRunId}
            hideBypassRunIds={runTreeDisplay.hideBypassRunIds}
            subtreeRollupsByRunId={subtreeRollups ?? undefined}
            subtreeRollupsComplete={fullTracePayloadsLoaded}
            timeline={showWaterfall ? waterfall.timeline : null}
          />
        ) : (
          <div className="text-sm text-zinc-500">
            No runs visible with the current hide filters.
          </div>
        )}
      </div>
    </GlassCard>
  );
  const runDetailCard = (
    <RunDetail
      key="detail"
      run={selectedRun}
      payloadCache={payloadCache}
      payloadLoading={payloadLoading}
      onLoadPayload={loadPayload}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <TraceHeader
        trace={tree.trace}
        aggregates={aggregates}
        missingTracePayloadCount={missingTracePayloadRefs.length}
        tracePayloadBatchLoading={tracePayloadBatchLoading}
        onLoadTracePayloads={handleLoadTracePayloads}
        showTracePayloadControls={selectedProfile.requiresFullPayloads}
        customCoverage={customCoverage}
      />
      <div
        className="grid min-h-0 flex-1 gap-3 transition-[grid-template-columns] duration-500 ease-[var(--ease-glass)] motion-reduce:transition-none"
        style={{
          gridTemplateColumns: layoutFocus === 'run-tree' ? '1.35fr 0.65fr' : '0.65fr 1.35fr',
        }}
      >
        {runTreeCard}
        {runDetailCard}
      </div>
    </div>
  );
}
