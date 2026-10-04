import type { Trace, TraceRecord, TraceRun, TraceViewerApi } from '@m4trix/tracing';
import { decodeJsonStrings, flattenLeaves, type PayloadLeaf, payloadSize } from './json-utils';

export type PayloadSide = 'input' | 'output';

export type IndexedPayload = {
  ref: string;
  runId: string;
  side: PayloadSide;
  /** Payload with JSON-in-string values decoded (see `decodeJsonStrings`). */
  value: unknown;
  leaves: PayloadLeaf[];
  size: number;
};

export type IndexedTrace = {
  trace: Trace;
  runs: Map<string, TraceRun>;
  payloads: Map<string, IndexedPayload>;
  size: number;
  failures: { ref: string; message: string }[];
};

export type LoadTraceResult = {
  traceId: string;
  traceName: string;
  status: string;
  loaded: number;
  alreadyLoaded: number;
  failed: { ref: string; message: string }[];
  size: number;
  evicted: string[];
};

export type PayloadIndexOptions = {
  /** Approximate budget (serialized JSON characters) before least-recently-used traces are evicted. */
  maxChars?: number;
  /** Parallel payload fetches per trace. */
  concurrency?: number;
};

const DEFAULT_MAX_CHARS = 200_000_000;
const DEFAULT_CONCURRENCY = 8;

export function payloadRefsOf(run: TraceRun): { ref: string; side: PayloadSide }[] {
  const refs: { ref: string; side: PayloadSide }[] = [];
  if (run.inputRef) refs.push({ ref: run.inputRef, side: 'input' });
  if (run.outputRef) refs.push({ ref: run.outputRef, side: 'output' });
  return refs;
}

/**
 * In-memory, per-trace cache of decoded and flattened payloads that `search_payloads`,
 * `analyze_trace` and `compare` read from. Payload blobs are immutable once written, so
 * reloading a trace only fetches refs that appeared since the last load.
 */
export class PayloadIndex {
  private readonly traces = new Map<string, IndexedTrace>();
  private readonly maxChars: number;
  private readonly concurrency: number;

  constructor(
    private readonly api: TraceViewerApi,
    options: PayloadIndexOptions = {},
  ) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /** Loaded traces, most recently used last. */
  loadedTraces(): IndexedTrace[] {
    return [...this.traces.values()];
  }

  get(traceId: string): IndexedTrace | undefined {
    return this.traces.get(traceId);
  }

  totalSize(): number {
    let total = 0;
    for (const entry of this.traces.values()) total += entry.size;
    return total;
  }

  isFullyLoaded(record: TraceRecord): boolean {
    const entry = this.traces.get(record.trace.traceId);
    if (!entry) return false;
    return record.runs.every((run) =>
      payloadRefsOf(run).every(({ ref }) => entry.payloads.has(ref)),
    );
  }

  /** Cached payload for a ref, if its trace is loaded. */
  getPayload(traceId: string, ref: string): IndexedPayload | undefined {
    return this.traces.get(traceId)?.payloads.get(ref);
  }

  unload(traceId: string): boolean {
    return this.traces.delete(traceId);
  }

  async loadTrace(record: TraceRecord): Promise<LoadTraceResult> {
    const traceId = record.trace.traceId;
    const existing = this.traces.get(traceId);
    const entry: IndexedTrace = existing ?? {
      trace: record.trace,
      runs: new Map(),
      payloads: new Map(),
      size: 0,
      failures: [],
    };
    entry.trace = record.trace;
    entry.runs = new Map(record.runs.map((run) => [run.runId, run]));

    const pending = record.runs.flatMap((run) =>
      payloadRefsOf(run)
        .filter(({ ref }) => !entry.payloads.has(ref))
        .map(({ ref, side }) => ({ ref, side, runId: run.runId })),
    );
    const alreadyLoaded =
      record.runs.reduce((sum, run) => sum + payloadRefsOf(run).length, 0) - pending.length;

    const failed: { ref: string; message: string }[] = [];
    let loaded = 0;
    await forEachConcurrent(pending, this.concurrency, async (item) => {
      try {
        const raw = await this.api.getPayload<unknown>(item.ref);
        const value = decodeJsonStrings(raw);
        const size = payloadSize(raw);
        entry.payloads.set(item.ref, {
          ref: item.ref,
          runId: item.runId,
          side: item.side,
          value,
          leaves: flattenLeaves(value),
          size,
        });
        entry.size += size;
        loaded += 1;
      } catch (error) {
        failed.push({
          ref: item.ref,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    entry.failures = failed;

    // Re-insert so Map order tracks recency for eviction.
    this.traces.delete(traceId);
    this.traces.set(traceId, entry);
    const evicted = this.evict(traceId);

    return {
      traceId,
      traceName: record.trace.name,
      status: record.trace.status,
      loaded,
      alreadyLoaded,
      failed,
      size: entry.size,
      evicted,
    };
  }

  private evict(keepTraceId: string): string[] {
    const evicted: string[] = [];
    let total = this.totalSize();
    for (const [traceId, entry] of this.traces) {
      if (total <= this.maxChars) break;
      if (traceId === keepTraceId) continue;
      this.traces.delete(traceId);
      total -= entry.size;
      evicted.push(traceId);
    }
    return evicted;
  }
}

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}
