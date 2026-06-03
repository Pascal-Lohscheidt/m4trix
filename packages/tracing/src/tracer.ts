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

export class Tracer {
  name = 'm4trix_tracer';
  awaitHandlers = true;

  private readonly runs = new Map<string, TraceRun>();
  private readonly pendingRuns = new Map<string, TraceRun>();
  private readonly pendingTraces = new Map<string, Trace>();
  private readonly inFlight = new Set<Promise<void>>();

  private constructor(private readonly traceStore: TraceStore) {}

  static from(traceStore: TraceStore): Tracer {
    return new Tracer(traceStore);
  }

  adapt<TAdapted>(adapter: TracerAdapter<TAdapted>): TAdapted {
    return adapter(this);
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

  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }

    const runs = [...this.pendingRuns.values()];
    const traces = [...this.pendingTraces.values()];
    this.pendingRuns.clear();
    this.pendingTraces.clear();

    await this.traceStore.upsertRunBatch(runs);
    for (const trace of traces) {
      await this.traceStore.upsertTrace(trace);
    }
  }

  private track(promise: Promise<void>): Promise<void> {
    this.inFlight.add(promise);
    return promise.finally(() => {
      this.inFlight.delete(promise);
    });
  }

  private async startRun(options: RunStartOptions): Promise<void> {
    const parentRun = options.parentRunId ? this.runs.get(options.parentRunId) : undefined;
    const traceId = parentRun?.traceId ?? options.parentRunId ?? options.runId;
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

    this.runs.set(options.runId, run);
    this.pendingRuns.set(options.runId, run);
    this.updateTrace(run, options.metadata);
  }

  private async endRun(
    runId: string,
    status: TraceStatus,
    output?: unknown,
    error?: Error,
    tokens?: TraceTokens,
  ): Promise<void> {
    const currentRun = this.runs.get(runId);
    if (!currentRun) return;

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

    this.runs.set(runId, run);
    this.pendingRuns.set(runId, run);
    this.updateTrace(run);
  }

  private updateTrace(run: TraceRun, metadata?: Record<string, unknown>): void {
    if (run.parentRunId) {
      this.updateRootTrace(run.traceId);
      return;
    }

    const existingTrace = this.pendingTraces.get(run.traceId);
    const traceMetadata = toTraceMetadata(metadata) ?? run.metadata ?? existingTrace?.metadata;
    const traceRuns = [...this.runs.values()].filter(
      (candidate) => candidate.traceId === run.traceId,
    );
    const trace: Trace = {
      schemaVersion: 1,
      traceId: run.traceId,
      rootRunId: run.runId,
      ...(metadata?.projectId && typeof metadata.projectId === 'string'
        ? { projectId: metadata.projectId }
        : existingTrace?.projectId
          ? { projectId: existingTrace.projectId }
          : {}),
      name: run.name,
      status: traceRuns.some((candidate) => candidate.status === 'error') ? 'error' : run.status,
      startTime: run.startTime,
      ...(run.endTime ? { endTime: run.endTime } : {}),
      ...(run.latencyMs !== undefined ? { latencyMs: run.latencyMs } : {}),
      ...(run.tokens ? { tokens: { input: run.tokens.input, output: run.tokens.output } } : {}),
      runCount: traceRuns.length,
      ...(traceMetadata ? { metadata: traceMetadata } : {}),
    };

    this.pendingTraces.set(run.traceId, trace);
  }

  private updateRootTrace(traceId: string): void {
    const rootRun = [...this.runs.values()].find(
      (run) => run.traceId === traceId && !run.parentRunId,
    );
    if (rootRun) this.updateTrace(rootRun);
  }
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
