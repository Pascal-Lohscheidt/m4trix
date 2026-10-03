import type { RunNode, TraceFilters, TraceRow } from '../types';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function statusTextClass(status: string): string {
  switch (status) {
    case 'success':
      return 'text-emerald-400';
    case 'error':
      return 'text-rose-400';
    default:
      return 'text-amber-300';
  }
}

export function statusDotClass(status: string): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-400 shadow-[0_0_10px_rgb(52_211_153_/_0.6)]';
    case 'error':
      return 'bg-rose-400 shadow-[0_0_10px_rgb(251_113_133_/_0.6)]';
    default:
      return 'bg-amber-300 shadow-[0_0_10px_rgb(252_211_77_/_0.6)]';
  }
}

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Human-friendly timestamp; falls back to the raw value when it is not a parseable date. */
export function formatTimestamp(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timestampFormat.format(date);
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
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
