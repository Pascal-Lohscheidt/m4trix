import { TreeStructureIcon } from '@phosphor-icons/react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { MapperDialog } from './components/mapper/MapperDialog';
import { SettingsModal } from './components/SettingsModal';
import { TraceMainPanel } from './components/TraceMainPanel';
import { type LayoutFocus, Toolbar } from './components/Toolbar';
import { TraceSidebar } from './components/TraceSidebar';
import { usePayloadCache } from './hooks/usePayloadCache';
import { useSelectedTraceTree } from './hooks/useSelectedTraceTree';
import { useTraceList } from './hooks/useTraceList';
import { useViewerUrlState } from './hooks/useViewerUrlState';
import { cx, findRun } from './lib/viewer';
import {
  MapperDialogContextProvider,
  type MapperDialogRequest,
} from './state/mapper-dialog-context';
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

  const { traceId, runId, view, selectTrace, selectRun, setView } = useViewerUrlState();
  const { tree, treeErr } = useSelectedTraceTree(traceId);
  // The tree hook clears synchronously in an effect, so guard against one stale render.
  const currentTree = tree && tree.trace.traceId === traceId ? tree : null;
  const payload = usePayloadCache(traceId);

  const [layoutFocus, setLayoutFocus] = useState<LayoutFocus>('run-tree');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mapper, setMapper] = useState<{ key: number; request: MapperDialogRequest } | null>(null);
  const openMapper = useCallback((request: MapperDialogRequest) => {
    setSettingsOpen(false);
    setMapper((prev) => ({ key: (prev?.key ?? 0) + 1, request }));
  }, []);

  // Deselect only when the list filters exclude the trace. A linked trace that is not in the
  // list at all (older than the list window, or the list is still loading) stays selected.
  useEffect(() => {
    if (!traceId) return;
    if (!traces.some((trace) => trace.traceId === traceId)) return;
    if (filteredTraces.some((trace) => trace.traceId === traceId)) return;
    selectTrace(null);
  }, [traces, filteredTraces, traceId, selectTrace]);

  // Land on the root run when nothing (or a run from elsewhere) is selected.
  useEffect(() => {
    if (!currentTree) return;
    if (runId && findRun(currentTree.root, runId)) return;
    selectRun(currentTree.root.runId);
  }, [currentTree, runId, selectRun]);

  return (
    <MapperDialogContextProvider openMapper={openMapper}>
      <div className="aurora flex h-screen gap-3 overflow-hidden p-3 text-zinc-200">
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
          onSelectTrace={selectTrace}
        />
        <main className="flex min-w-0 flex-1 flex-col gap-3 pr-1">
          <Toolbar
            query={filters.query}
            onQueryChange={(query) => setFilters({ ...filters, query })}
            layoutFocus={layoutFocus}
            onLayoutFocusChange={setLayoutFocus}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {traceId && currentTree ? (
            <TraceMainPanel
              tree={currentTree}
              treeErr={treeErr}
              runId={runId}
              setRunId={selectRun}
              view={view}
              onViewChange={setView}
              layoutFocus={layoutFocus}
              payloadCache={payload.payloadCache}
              payloadLoading={payload.payloadLoading}
              tracePayloadBatchLoading={payload.tracePayloadBatchLoading}
              loadPayload={payload.loadPayload}
              loadManyPayloads={payload.loadManyPayloads}
            />
          ) : (
            <EmptyState message={treeErr} loading={Boolean(traceId) && !treeErr} />
          )}
        </main>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        {mapper && (
          <MapperDialog
            key={mapper.key}
            request={mapper.request}
            onClose={() => setMapper(null)}
            traces={filteredTraces}
            currentTraceId={traceId}
            currentTree={currentTree}
            payloadCache={payload.payloadCache}
          />
        )}
      </div>
    </MapperDialogContextProvider>
  );
}

function EmptyState({ message, loading }: { message: string | null; loading: boolean }): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center pb-16">
      <div className="max-w-sm text-center">
        <div className="glass mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-violet-300">
          <TreeStructureIcon aria-hidden="true" weight="duotone" className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
          {message ? 'Could not load trace' : loading ? 'Loading trace…' : 'Pick a trace'}
        </h1>
        <p className={cx('mt-2 text-sm', message ? 'text-rose-300' : 'text-zinc-500')}>
          {message ?? 'Select a trace on the left to inspect its runs, metadata and payloads.'}
        </p>
      </div>
    </div>
  );
}
