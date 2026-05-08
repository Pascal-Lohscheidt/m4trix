import type { RunNode, TraceFilters, TraceRow } from '../types';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function statusTextClass(status: string): string {
  switch (status) {
    case 'success':
      return 'text-emerald-400';
    case 'error':
      return 'text-red-400';
    default:
      return 'text-amber-400';
  }
}

export function getTraceEnv(trace: TraceRow): string {
  const env = trace.metadata?.env;
  return env == null ? '' : String(env);
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function matchesTraceFilters(trace: TraceRow, filters: TraceFilters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (filters.env && getTraceEnv(trace) !== filters.env) return false;
  if (filters.status && trace.status !== filters.status) return false;
  if (filters.projectId && trace.projectId !== filters.projectId) return false;
  if (!query) return true;

  return [trace.name, trace.traceId, trace.projectId, getTraceEnv(trace)]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(query));
}

export function findRun(root: RunNode, runId: string): RunNode | null {
  if (root.runId === runId) return root;
  for (const child of root.children) {
    const found = findRun(child, runId);
    if (found) return found;
  }
  return null;
}
