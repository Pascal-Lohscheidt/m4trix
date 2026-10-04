import type { TraceStore } from './trace-store.js';
import type {
  Trace,
  TraceMetadata,
  TraceRun,
  TraceRunType,
  TraceStatus,
  TraceTokens,
} from './types.js';

type RunStartOptions = {
  runId: string;
  parentRunId?: string;
  type: TraceRunType;
  name?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

/** Maps a `Tracer` instance to a framework-specific callback surface (e.g. LangGraph). */
export type TracerAdapter<TAdapted> = (tracer: Tracer) => TAdapted;

type TraceState = {
  runs: Map<string, TraceRun>;
  projectId?: string;
};

/**
 * Collects callback events into runs and traces. A trace stays in memory until none of its runs is
 * still running and a flush has written it; after that it is released, so a long-lived tracer does
 * not grow with every trace it has seen.
 */
export class Tracer {
  name = 'm4trix_tracer';
  awaitHandlers = true;

  private readonly traces = new Map<string, TraceState>();
  private readonly runTraceIds = new Map<string, string>();
  private readonly pendingRuns = new Map<string, TraceRun>();
  private readonly dirtyTraceIds = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private flushQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly traceStore: TraceStore) {}

  static from(traceStore: TraceStore): Tracer {
    return new Tracer(traceStore);
  }

  adapt<TAdapted>(adapter: TracerAdapter<TAdapted>): TAdapted {
    return adapter(this);
  }

  /** Number of traces still held in memory (running, or finished but not yet flushed). */
  get activeTraceCount(): number {
    return this.traces.size;
  }

  async handleChainStart(
    serialized: unknown,
    inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runTypeOrName?: string,
    name?: string,
  ): Promise<void> {
    const chainType = isTraceRunType(runTypeOrName) ? runTypeOrName : 'chain';
    const chainName = name ?? (isTraceRunType(runTypeOrName) ? undefined : runTypeOrName);

    return this.track(
      this.startRun({
        extra: compactRecord({ runType: runTypeOrName, serialized, tags }),
        input: inputs,
        metadata,
        name: chainName ?? inferName(serialized) ?? chainType,
        parentRunId,
        runId,
        type: chainType,
      }),
    );
  }

  async handleChainEnd(outputs: unknown, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'success', outputs));
  }

  async handleChainError(error: Error, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'error', undefined, error));
  }

  async handleLLMStart(
    serialized: unknown,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    return this.track(
      this.startRun({
        extra: compactRecord({ extraParams, serialized, tags }),
        input: prompts,
        metadata,
        name: name ?? inferName(serialized) ?? 'LLM',
        parentRunId,
        runId,
        type: 'llm',
      }),
    );
  }

  async handleChatModelStart(
    serialized: unknown,
    messages: unknown,
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    return this.track(
      this.startRun({
        extra: compactRecord({ extraParams, serialized, tags }),
        input: messages,
        metadata,
        name: name ?? inferName(serialized) ?? 'Chat model',
        parentRunId,
        runId,
        type: 'chat_model',
      }),
    );
  }

  async handleLLMEnd(output: unknown, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'success', output, undefined, extractTokens(output)));
  }

  async handleLLMError(error: Error, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'error', undefined, error));
  }

  async handleToolStart(
    serialized: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    return this.track(
      this.startRun({
        extra: compactRecord({ serialized, tags }),
        input,
        metadata,
        name: name ?? inferName(serialized) ?? 'Tool',
        parentRunId,
        runId,
        type: 'tool',
      }),
    );
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'success', output));
  }

  async handleToolError(error: Error, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'error', undefined, error));
  }

  async handleRetrieverStart(
    serialized: unknown,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    return this.track(
      this.startRun({
        extra: compactRecord({ serialized, tags }),
        input: query,
        metadata,
        name: name ?? inferName(serialized) ?? 'Retriever',
        parentRunId,
        runId,
        type: 'retriever',
      }),
    );
  }

  async handleRetrieverEnd(documents: unknown, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'success', documents));
  }

  async handleRetrieverError(error: Error, runId: string): Promise<void> {
    return this.track(this.endRun(runId, 'error', undefined, error));
  }

  /**
   * Writes pending runs and traces to the store. Flushes run one at a time so an older snapshot can
   * never land after a newer one; records from a failed flush are queued again for the next one.
   */
  flush(): Promise<void> {
    const flushed = this.flushQueue.then(() => this.flushPending());
    this.flushQueue = flushed.catch(() => {});
    return flushed;
  }

  private async flushPending(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }

    const runs = [...this.pendingRuns.values()];
    const traceIds = [...this.dirtyTraceIds];
    this.pendingRuns.clear();
    this.dirtyTraceIds.clear();
    const traces = traceIds.flatMap((traceId) => this.buildTrace(traceId) ?? []);

    try {
      await this.traceStore.upsertRunBatch(runs);
      for (const trace of traces) {
        await this.traceStore.upsertTrace(trace);
      }
    } catch (error) {
      this.requeue(runs, traceIds);
      throw error;
    }

    this.releaseFinished(traceIds);
  }

  /** Puts records back unless a newer version was queued while the failed write was in flight. */
  private requeue(runs: TraceRun[], traceIds: string[]): void {
    for (const run of runs) {
      if (!this.pendingRuns.has(run.runId)) this.pendingRuns.set(run.runId, run);
    }
    for (const traceId of traceIds) {
      this.dirtyTraceIds.add(traceId);
    }
  }

  /** Drops written traces that have no running runs and no changes since they were written. */
  private releaseFinished(traceIds: string[]): void {
    for (const traceId of traceIds) {
      const state = this.traces.get(traceId);
      if (!state || this.dirtyTraceIds.has(traceId)) continue;
      if ([...state.runs.values()].some((run) => run.status === 'running')) continue;

      this.traces.delete(traceId);
      for (const runId of state.runs.keys()) {
        this.runTraceIds.delete(runId);
      }
    }
  }

  private track(promise: Promise<void>): Promise<void> {
    this.inFlight.add(promise);
    return promise.finally(() => {
      this.inFlight.delete(promise);
    });
  }

  private async startRun(options: RunStartOptions): Promise<void> {
    const parentTraceId = options.parentRunId
      ? this.runTraceIds.get(options.parentRunId)
      : undefined;
    const traceId = parentTraceId ?? options.parentRunId ?? options.runId;
    const inputRef = await this.traceStore.putJsonPayload(
      payloadPath(traceId, options.runId, 'input.json'),
      options.input,
    );
    const metadata = toTraceMetadata(options.metadata);
    const run: TraceRun = {
      schemaVersion: 1,
      traceId,
      runId: options.runId,
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      type: options.type,
      name: options.name ?? options.type,
      status: 'running',
      startTime: nowIso(),
      inputRef,
      ...(metadata ? { metadata } : {}),
      ...(options.extra && Object.keys(options.extra).length > 0 ? { extra: options.extra } : {}),
    };

    let state = this.traces.get(traceId);
    if (!state) {
      state = { runs: new Map() };
      this.traces.set(traceId, state);
    }
    const projectId = options.metadata?.projectId;
    if (!options.parentRunId && typeof projectId === 'string' && projectId) {
      state.projectId = projectId;
    }

    this.recordRun(state, run);
  }

  private async endRun(
    runId: string,
    status: TraceStatus,
    output?: unknown,
    error?: Error,
    tokens?: TraceTokens,
  ): Promise<void> {
    const traceId = this.runTraceIds.get(runId);
    const state = traceId === undefined ? undefined : this.traces.get(traceId);
    const currentRun = state?.runs.get(runId);
    if (!state || !currentRun) return;

    const endTime = nowIso();
    const outputRef =
      output === undefined
        ? undefined
        : await this.traceStore.putJsonPayload(
            payloadPath(currentRun.traceId, runId, 'output.json'),
            output,
          );
    const run: TraceRun = {
      ...currentRun,
      status,
      endTime,
      latencyMs: Date.parse(endTime) - Date.parse(currentRun.startTime),
      ...(outputRef ? { outputRef } : {}),
      ...(tokens ? { tokens } : {}),
      ...(error ? { error: { message: error.message, type: error.name || undefined } } : {}),
    };

    this.recordRun(state, run);
  }

  private recordRun(state: TraceState, run: TraceRun): void {
    state.runs.set(run.runId, run);
    this.runTraceIds.set(run.runId, run.traceId);
    this.pendingRuns.set(run.runId, run);
    this.dirtyTraceIds.add(run.traceId);
  }

  /** Summarizes a trace from its root run, adding up token usage across all runs. */
  private buildTrace(traceId: string): Trace | undefined {
    const state = this.traces.get(traceId);
    if (!state) return undefined;

    const runs = [...state.runs.values()];
    const root = runs.find((run) => !run.parentRunId);
    if (!root) return undefined;

    const tokens = sumTokens(runs);
    return {
      schemaVersion: 1,
      traceId,
      rootRunId: root.runId,
      ...(state.projectId ? { projectId: state.projectId } : {}),
      name: root.name,
      status: runs.some((run) => run.status === 'error') ? 'error' : root.status,
      startTime: root.startTime,
      ...(root.endTime ? { endTime: root.endTime } : {}),
      ...(root.latencyMs !== undefined ? { latencyMs: root.latencyMs } : {}),
      ...(tokens ? { tokens } : {}),
      runCount: runs.length,
      ...(root.metadata ? { metadata: root.metadata } : {}),
    };
  }
}

function sumTokens(runs: TraceRun[]): Trace['tokens'] {
  let total: Trace['tokens'];
  for (const run of runs) {
    if (!run.tokens) continue;
    total = {
      input: (total?.input ?? 0) + run.tokens.input,
      output: (total?.output ?? 0) + run.tokens.output,
    };
  }
  return total;
}

function payloadPath(traceId: string, runId: string, fileName: string): string {
  return `traces/${traceId}/payloads/${runId}/${fileName}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function inferName(serialized: unknown): string | undefined {
  if (!serialized || typeof serialized !== 'object') return undefined;
  const value = serialized as Record<string, unknown>;
  if (typeof value.name === 'string') return value.name;
  if (typeof value.id === 'string') return value.id;
  if (Array.isArray(value.id)) return value.id.filter((part) => typeof part === 'string').at(-1);
  return undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function toTraceMetadata(metadata: Record<string, unknown> | undefined): TraceMetadata | undefined {
  if (!metadata) return undefined;

  const entries = Object.entries(metadata).filter(
    (entry): entry is [string, string | number | boolean] =>
      entry[0] !== 'projectId' &&
      (typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean'),
  );

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function extractTokens(output: unknown): TraceTokens | undefined {
  if (!output || typeof output !== 'object') return undefined;

  const tokenUsage = (output as { llmOutput?: { tokenUsage?: Record<string, unknown> } }).llmOutput
    ?.tokenUsage;
  if (!tokenUsage) return undefined;

  const input =
    readNumber(tokenUsage.promptTokens) ??
    readNumber(tokenUsage.input_tokens) ??
    readNumber(tokenUsage.inputTokens);
  const outputTokens =
    readNumber(tokenUsage.completionTokens) ??
    readNumber(tokenUsage.output_tokens) ??
    readNumber(tokenUsage.outputTokens);
  const cached = readNumber(tokenUsage.cachedTokens) ?? readNumber(tokenUsage.cached_tokens);

  if (input === undefined && outputTokens === undefined) return undefined;

  return {
    input: input ?? 0,
    output: outputTokens ?? 0,
    ...(cached !== undefined ? { cached } : {}),
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isTraceRunType(value: string | undefined): value is TraceRunType {
  return (
    value === 'agent' ||
    value === 'chain' ||
    value === 'llm' ||
    value === 'chat_model' ||
    value === 'tool' ||
    value === 'retriever' ||
    value === 'embedding' ||
    value === 'prompt' ||
    value === 'parser'
  );
}
