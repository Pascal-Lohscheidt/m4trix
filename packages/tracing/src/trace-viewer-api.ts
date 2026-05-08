import type { TraceStore } from './trace-store.js';
import type { ListTracesQuery, ListTracesResult, Trace, TraceRecord, TraceRun, TraceRunNode } from './types.js';

export class TraceViewerApi {
  private constructor(private readonly traceStore: TraceStore) {}

  static from(traceStore: TraceStore): TraceViewerApi {
    return new TraceViewerApi(traceStore);
  }

  listTraces(query?: ListTracesQuery): Promise<ListTracesResult> {
    return this.traceStore.listTraces(query);
  }

  getTrace(traceId: string): Promise<TraceRecord | null> {
    return this.traceStore.getTrace(traceId);
  }

  async getTraceTree(traceId: string): Promise<{ trace: Trace; root: TraceRunNode } | null> {
    const record = await this.traceStore.getTrace(traceId);
    if (!record) return null;

    const nodes = new Map<string, TraceRunNode>();
    for (const run of record.runs) {
      nodes.set(run.runId, { ...run, children: [] });
    }

    for (const node of nodes.values()) {
      if (!node.parentRunId) continue;

      const parent = nodes.get(node.parentRunId);
      if (parent) parent.children.push(node);
    }

    for (const node of nodes.values()) {
      node.children.sort(compareRunsByStartTime);
    }

    const root = nodes.get(record.trace.rootRunId);
    if (!root || root.parentRunId) return null;

    return { trace: record.trace, root };
  }

  getPayload<T = unknown>(ref: string): Promise<T> {
    return this.traceStore.getPayload<T>(ref);
  }
}

function compareRunsByStartTime(left: TraceRun, right: TraceRun): number {
  return left.startTime.localeCompare(right.startTime) || left.runId.localeCompare(right.runId);
}
