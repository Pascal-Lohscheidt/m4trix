import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseViewerUrlState,
  type RunTreeView,
  serializeViewerUrlState,
  type ViewerUrlState,
} from '../lib/url-state';

/**
 * Trace / run / view selection backed by the query string. Picking a trace pushes a history
 * entry (so Back returns to the previous trace); run and view changes replace the current one.
 */
export function useViewerUrlState() {
  const [state, setState] = useState<ViewerUrlState>(() =>
    parseViewerUrlState(window.location.search),
  );
  const lastTraceId = useRef(state.traceId);

  useEffect(() => {
    const onPopState = () => setState(parseViewerUrlState(window.location.search));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const traceChanged = state.traceId !== lastTraceId.current;
    lastTraceId.current = state.traceId;
    const search = serializeViewerUrlState(state, window.location.search);
    if (search === window.location.search) return;
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (traceChanged) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, [state]);

  const selectTrace = useCallback((traceId: string | null) => {
    setState((prev) => (prev.traceId === traceId ? prev : { ...prev, traceId, runId: null }));
  }, []);
  const selectRun = useCallback((runId: string | null) => {
    setState((prev) => (prev.runId === runId ? prev : { ...prev, runId }));
  }, []);
  const setView = useCallback((view: RunTreeView) => {
    setState((prev) => (prev.view === view ? prev : { ...prev, view }));
  }, []);

  return { ...state, selectTrace, selectRun, setView };
}
