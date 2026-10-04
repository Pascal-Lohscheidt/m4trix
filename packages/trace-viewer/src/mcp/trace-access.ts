import type {
  ListTracesQuery,
  Trace,
  TraceRecord,
  TraceRun,
  TraceViewerApi,
} from '@m4trix/tracing';

/** Upper bound on traces scanned when resolving id prefixes or filtering client-side. */
export const MAX_TRACE_SCAN = 2000;
const SCAN_PAGE_SIZE = 200;

export class TraceToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceToolError';
  }
}

export type RunTreeNode = TraceRun & { depth: number; children: RunTreeNode[] };

export type RunForest = {
  /** Roots in start order: the trace root first, then orphans whose parent is missing. */
  roots: RunTreeNode[];
  byId: Map<string, RunTreeNode>;
  orphanRunIds: string[];
};

/** First 8 chars of UUID-like ids (unique in practice); short custom ids are kept whole. */
export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function compareRunsByStartTime(left: TraceRun, right: TraceRun): number {
  return left.startTime.localeCompare(right.startTime) || left.runId.localeCompare(right.runId);
}

/** Scans traces newest-first, page by page, until `visit` returns false or the scan cap is hit. */
export async function scanTraces(
  api: TraceViewerApi,
  query: Omit<ListTracesQuery, 'limit' | 'cursor'>,
  visit: (trace: Trace) => boolean,
  maxScan = MAX_TRACE_SCAN,
): Promise<{ scanned: number; exhausted: boolean }> {
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < maxScan) {
    const page = await api.listTraces({
      ...query,
      limit: Math.min(SCAN_PAGE_SIZE, maxScan - scanned),
      ...(cursor ? { cursor } : {}),
    });
    for (const trace of page.traces) {
      scanned += 1;
      if (!visit(trace)) return { scanned, exhausted: false };
    }
    if (!page.nextCursor || page.traces.length === 0) return { scanned, exhausted: true };
    cursor = page.nextCursor;
  }
  return { scanned, exhausted: false };
}

/**
 * Resolves `latest`, a full trace id, or a unique id prefix to a stored trace record.
 */
export async function resolveTrace(api: TraceViewerApi, traceRef: string): Promise<TraceRecord> {
  const ref = traceRef.trim();
  if (!ref) throw new TraceToolError('traceId is required.');

  if (ref === 'latest') {
    const { traces } = await api.listTraces({ limit: 1 });
    const latest = traces[0];
    if (!latest) throw new TraceToolError('No traces found in the trace store.');
    return requireRecord(api, latest.traceId);
  }

  const exact = await api.getTrace(ref).catch(() => null);
  if (exact) return exact;

  const candidates: string[] = [];
  await scanTraces(api, {}, (trace) => {
    if (trace.traceId.startsWith(ref)) candidates.push(trace.traceId);
    return candidates.length < 6;
  });
  if (candidates.length === 0) throw new TraceToolError(`Trace "${ref}" not found.`);
  if (candidates.length > 1) {
    throw new TraceToolError(
      `Trace prefix "${ref}" is ambiguous: ${candidates.join(', ')}. Use a longer prefix.`,
    );
  }
  return requireRecord(api, candidates[0]);
}

async function requireRecord(api: TraceViewerApi, traceId: string): Promise<TraceRecord> {
  const record = await api.getTrace(traceId);
  if (!record) throw new TraceToolError(`Trace "${traceId}" not found.`);
  return record;
}

/** Resolves a full run id or unique prefix within a trace. */
export function resolveRun(record: TraceRecord, runRef: string): TraceRun {
  const ref = runRef.trim();
  const exact = record.runs.find((run) => run.runId === ref);
  if (exact) return exact;
  const candidates = record.runs.filter((run) => run.runId.startsWith(ref));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new TraceToolError(`Run "${ref}" not found in trace ${record.trace.traceId}.`);
  }
  throw new TraceToolError(
    `Run prefix "${ref}" is ambiguous: ${candidates.map((run) => run.runId).join(', ')}.`,
  );
}

/**
 * Builds the run tree without dropping data: runs whose parent was never written
 * (crashed or still-running traces) become extra roots and are reported as orphans.
 */
export function buildRunForest(record: TraceRecord): RunForest {
  const byId = new Map<string, RunTreeNode>();
  for (const run of record.runs) byId.set(run.runId, { ...run, depth: 0, children: [] });

  const roots: RunTreeNode[] = [];
  const orphanRunIds: string[] = [];
  for (const node of byId.values()) {
    const parent = node.parentRunId ? byId.get(node.parentRunId) : undefined;
    if (parent) {
      parent.children.push(node);
      continue;
    }
    roots.push(node);
    if (node.parentRunId) orphanRunIds.push(node.runId);
  }

  const assignDepth = (node: RunTreeNode, depth: number): void => {
    node.depth = depth;
    node.children.sort(compareRunsByStartTime);
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort((left, right) => {
    if (left.runId === record.trace.rootRunId) return -1;
    if (right.runId === record.trace.rootRunId) return 1;
    return compareRunsByStartTime(left, right);
  });
  for (const root of roots) assignDepth(root, 0);

  return { roots, byId, orphanRunIds };
}

/** Names from the trace root down to (and including) the run. */
export function runAncestry(forest: RunForest, runId: string): RunTreeNode[] {
  const chain: RunTreeNode[] = [];
  const seen = new Set<string>();
  let current = forest.byId.get(runId);
  while (current && !seen.has(current.runId)) {
    seen.add(current.runId);
    chain.unshift(current);
    current = current.parentRunId ? forest.byId.get(current.parentRunId) : undefined;
  }
  return chain;
}

export function walkForest(forest: RunForest, visit: (node: RunTreeNode) => void): void {
  const stack = [...forest.roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as RunTreeNode;
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

export function statusIcon(status: string): string {
  switch (status) {
    case 'success':
      return '✓';
    case 'error':
      return '✗';
    default:
      return '…';
  }
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(
  tokens: { input: number; output: number; cached?: number } | undefined,
): string {
  if (!tokens) return '';
  const cached = tokens.cached ? ` cached ${tokens.cached}` : '';
  return `tok ${tokens.input}/${tokens.output}${cached}`;
}

export function formatMetadata(
  metadata: Record<string, unknown> | undefined,
  maxEntries = 6,
): string {
  if (!metadata) return '';
  const entries = Object.entries(metadata);
  const shown = entries.slice(0, maxEntries).map(([key, value]) => `${key}=${String(value)}`);
  if (entries.length > maxEntries) shown.push(`+${entries.length - maxEntries}`);
  return shown.join(' ');
}

export function formatTraceRow(trace: Trace): string {
  return [
    trace.traceId,
    `${statusIcon(trace.status)} ${trace.status}`,
    trace.name,
    trace.startTime,
    formatMs(trace.latencyMs),
    `${trace.runCount} runs`,
    formatTokens(trace.tokens),
    trace.costUsd !== undefined ? `$${trace.costUsd.toFixed(4)}` : '',
    trace.projectId ? `project=${trace.projectId}` : '',
    formatMetadata(trace.metadata),
    trace.annotation ? '[annotated]' : '',
  ]
    .filter(Boolean)
    .join('  ');
}

/** One-line run summary used by tree, search and analysis output. */
export function formatRunLabel(run: TraceRun, options: { errorChars?: number } = {}): string {
  const errorChars = options.errorChars ?? 160;
  const error =
    run.error && errorChars > 0 ? `  error: ${clip(run.error.message, errorChars)}` : '';
  return [
    `${statusIcon(run.status)} ${run.type} ${run.name}`,
    formatMs(run.latencyMs),
    formatTokens(run.tokens),
    `[${shortId(run.runId)}]`,
  ]
    .filter(Boolean)
    .join('  ')
    .concat(error);
}

function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}
