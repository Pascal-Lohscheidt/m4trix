import { type ReactNode, useEffect, useState } from 'react';
import { SettingsModal } from './components/SettingsModal';
import { TraceMainPanel } from './components/TraceMainPanel';
import { type LayoutFocus, Toolbar } from './components/Toolbar';
import { TraceSidebar } from './components/TraceSidebar';
import { usePayloadCache } from './hooks/usePayloadCache';
import { useSelectedTraceTree } from './hooks/useSelectedTraceTree';
import { useTraceList } from './hooks/useTraceList';
import { cx } from './lib/viewer';
import { useViewerSettings } from './state/viewer-settings-context';

export function TraceViewerPage(): ReactNode {
  const { settings } = useViewerSettings();
  const {
    traces,
    listErr,
    filters,
    setFilters,
    filteredTraces,
    envOptions,
    statusOptions,
    projectOptions,
  } = useTraceList(settings.autoUpdatePreset);

  const [traceId, setTraceId] = useState<string | null>(null);
  const { tree, treeErr, runId, setRunId } = useSelectedTraceTree(traceId);
  const payload = usePayloadCache(traceId);

  const [layoutFocus, setLayoutFocus] = useState<LayoutFocus>('run-tree');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (!traceId) return;
    if (filteredTraces.some((trace) => trace.traceId === traceId)) return;
    setTraceId(null);
  }, [filteredTraces, traceId]);

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
      {(!traceId || !tree) && (
        <div className="col-span-2 col-start-2 row-span-2 row-start-2 h-[calc(100vh-3rem)] overflow-auto bg-zinc-900 p-6 text-zinc-400">
          {treeErr ?? 'Select a trace to inspect runs and payloads.'}
        </div>
      )}
      {traceId && tree && (
        <TraceMainPanel
          tree={tree}
          treeErr={treeErr}
          runId={runId}
          setRunId={setRunId}
          payloadCache={payload.payloadCache}
          payloadLoading={payload.payloadLoading}
          tracePayloadBatchLoading={payload.tracePayloadBatchLoading}
          loadPayload={payload.loadPayload}
          loadManyPayloads={payload.loadManyPayloads}
        />
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
