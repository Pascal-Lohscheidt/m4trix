import type { Trace } from '@m4trix/tracing';
import type { RunTreeNode } from './trace-access';

export type RunFilter = {
  type?: string[];
  /** Case-insensitive regex against run names. */
  name?: string;
  status?: 'running' | 'success' | 'error';
  /** Case-insensitive substring of the run error message. */
  errorContains?: string;
  minLatencyMs?: number;
  /** Minimum input + output tokens. */
  minTokens?: number;
  /** Exact (stringified) equality against run metadata values. */
  metadata?: Record<string, string | number | boolean>;
  maxDepth?: number;
};

export function runMatchesFilter(
  run: RunTreeNode,
  filter: RunFilter,
  namePattern: RegExp | null,
): boolean {
  if (filter.type?.length && !filter.type.includes(run.type)) return false;
  if (namePattern && !namePattern.test(run.name)) return false;
  if (filter.status && run.status !== filter.status) return false;
  if (filter.errorContains) {
    const message = run.error?.message.toLowerCase() ?? '';
    if (!message.includes(filter.errorContains.toLowerCase())) return false;
  }
  if (filter.minLatencyMs !== undefined && (run.latencyMs ?? -1) < filter.minLatencyMs)
    return false;
  if (filter.minTokens !== undefined) {
    const tokens = run.tokens ? run.tokens.input + run.tokens.output : -1;
    if (tokens < filter.minTokens) return false;
  }
  if (filter.maxDepth !== undefined && run.depth > filter.maxDepth) return false;
  return metadataMatches(run.metadata, filter.metadata);
}

export function metadataMatches(
  metadata: Record<string, string | number | boolean> | undefined,
  expected: Record<string, string | number | boolean> | undefined,
): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(
    ([key, value]) => metadata?.[key] !== undefined && String(metadata[key]) === String(value),
  );
}

export type TraceFilter = {
  status?: Trace['status'];
  projectId?: string;
  /** Case-insensitive regex against trace names. */
  name?: string;
  metadata?: Record<string, string | number | boolean>;
  minLatencyMs?: number;
  annotated?: boolean;
};

export function traceMatchesFilter(
  trace: Trace,
  filter: TraceFilter,
  namePattern: RegExp | null,
): boolean {
  if (filter.status && trace.status !== filter.status) return false;
  if (filter.projectId && trace.projectId !== filter.projectId) return false;
  if (namePattern && !namePattern.test(trace.name)) return false;
  if (filter.minLatencyMs !== undefined && (trace.latencyMs ?? -1) < filter.minLatencyMs)
    return false;
  if (filter.annotated !== undefined && (trace.annotation !== undefined) !== filter.annotated)
    return false;
  return metadataMatches(trace.metadata, filter.metadata);
}
