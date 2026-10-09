export type RunTreeView = 'waterfall' | 'tree';

export const DEFAULT_RUN_TREE_VIEW: RunTreeView = 'waterfall';

/** Viewer selection mirrored in the query string so reloads and shared links land on the same run. */
export type ViewerUrlState = {
  traceId: string | null;
  runId: string | null;
  view: RunTreeView;
};

export function parseViewerUrlState(search: string): ViewerUrlState {
  const params = new URLSearchParams(search);
  const traceId = params.get('trace') || null;
  return {
    traceId,
    // A run only means something inside its trace.
    runId: traceId ? params.get('run') || null : null,
    view: params.get('view') === 'tree' ? 'tree' : DEFAULT_RUN_TREE_VIEW,
  };
}

/**
 * Writes the viewer keys into `search`, keeping unrelated params. Returns `''` or a string that
 * starts with `?`, so it can be compared with `location.search` directly.
 */
export function serializeViewerUrlState(state: ViewerUrlState, search = ''): string {
  const params = new URLSearchParams(search);
  // Re-append in a fixed order so the URL reads trace → run → view however it was reached.
  for (const key of ['trace', 'run', 'view']) params.delete(key);
  const append = (key: string, value: string | null) => {
    if (value) params.append(key, value);
  };
  append('trace', state.traceId);
  append('run', state.traceId ? state.runId : null);
  append('view', state.view === DEFAULT_RUN_TREE_VIEW ? null : state.view);
  const query = params.toString();
  return query ? `?${query}` : '';
}
