import { readLangChainModelParams, readLlmOutput } from './llm-output.js';
import {
  type EndRunInput,
  type RunHandle,
  type StartRunInput,
  TraceRecorder,
  type TracerOptions,
  type TracerStats,
} from './recorder.js';
import type { TraceStore } from './trace-store.js';
import type { TraceRunType } from './types.js';

/** Maps a `Tracer` instance to a framework-specific callback surface (e.g. LangGraph). */
export type TracerAdapter<TAdapted> = (tracer: Tracer) => TAdapted;

/**
 * Records traces into a {@link TraceStore}.
 *
 * Use it directly as a LangChain / LangGraph callback handler (`callbacks: [tracer]`), or call
 * {@link Tracer.startRun} to trace any other code. Tracing never throws into the traced code:
 * failures go to {@link TracerOptions.onError} and show up in {@link Tracer.stats}.
 */
export class Tracer {
  name = 'm4trix_tracer';
  awaitHandlers = true;

  private constructor(
    private readonly recorder: TraceRecorder,
    private readonly defaultParentRunId?: string,
  ) {}

  static from(traceStore: TraceStore, options?: TracerOptions): Tracer {
    return new Tracer(new TraceRecorder(traceStore, options));
  }

  adapt<TAdapted>(adapter: TracerAdapter<TAdapted>): TAdapted {
    return adapter(this);
  }

  /**
   * A tracer sharing this one's state whose top-level LangChain runs nest under `parentRunId`,
   * e.g. to put a LangGraph call inside a span started with {@link Tracer.startRun}.
   */
  childOf(parentRunId: string): Tracer {
    return new Tracer(this.recorder, parentRunId);
  }

  /** Number of traces still held in memory (running, or finished but not yet flushed). */
  get activeTraceCount(): number {
    return this.recorder.stats().activeTraces;
  }

  stats(): TracerStats {
    return this.recorder.stats();
  }

  /** Starts a run of any kind. Without a `parentRunId` it is the root of a new trace. */
  startRun(input: StartRunInput): RunHandle {
    return this.recorder.start(this.withDefaultParent(input)).handle;
  }

  endRun(runId: string, result?: EndRunInput): Promise<void> {
    return this.recorder.end(runId, result);
  }

  addEvent(runId: string, name: string, data?: unknown): void {
    this.recorder.addEvent(runId, name, data);
  }

  /** `traceparent` header that continues this run's trace in another service. */
  traceparent(runId: string): string | undefined {
    return this.recorder.traceparent(runId);
  }

  /** Writes everything recorded so far. Never rejects; failures go to `onError`. */
  flush(): Promise<void> {
    return this.recorder.flush();
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
    const type = isTraceRunType(runTypeOrName) ? runTypeOrName : 'chain';
    const runName = name ?? (isTraceRunType(runTypeOrName) ? undefined : runTypeOrName);
    return this.start({
      runId,
      parentRunId,
      type,
      name: runName ?? inferName(serialized) ?? type,
      input: inputs,
      tags,
      metadata,
      extra: compactRecord({ runType: runTypeOrName, serialized }),
    });
  }

  async handleChainEnd(outputs: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { output: outputs });
  }

  async handleChainError(error: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { error });
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
    return this.start({
      runId,
      parentRunId,
      type: 'llm',
      name: name ?? inferName(serialized) ?? 'LLM',
      input: prompts,
      tags,
      metadata,
      ...readLangChainModelParams(extraParams, metadata),
      extra: compactRecord({ extraParams, serialized }),
    });
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
    return this.start({
      runId,
      parentRunId,
      type: 'chat_model',
      name: name ?? inferName(serialized) ?? 'Chat model',
      input: messages,
      tags,
      metadata,
      ...readLangChainModelParams(extraParams, metadata),
      extra: compactRecord({ extraParams, serialized }),
    });
  }

  async handleLLMNewToken(_token: string, _idx: unknown, runId: string): Promise<void> {
    this.recorder.markFirstToken(runId);
  }

  async handleLLMEnd(output: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { output, ...readLlmOutput(output) });
  }

  async handleLLMError(error: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { error });
  }

  async handleToolStart(
    serialized: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
    toolCallId?: string,
  ): Promise<void> {
    return this.start({
      runId,
      parentRunId,
      type: 'tool',
      name: name ?? inferName(serialized) ?? 'Tool',
      input,
      tags,
      metadata,
      extra: compactRecord({ serialized, toolCallId }),
    });
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { output });
  }

  async handleToolError(error: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { error });
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
    return this.start({
      runId,
      parentRunId,
      type: 'retriever',
      name: name ?? inferName(serialized) ?? 'Retriever',
      input: query,
      tags,
      metadata,
      extra: compactRecord({ serialized }),
    });
  }

  async handleRetrieverEnd(documents: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { output: documents });
  }

  async handleRetrieverError(error: unknown, runId: string): Promise<void> {
    return this.recorder.end(runId, { error });
  }

  async handleText(text: string, runId: string): Promise<void> {
    this.recorder.addEvent(runId, 'text', { text });
  }

  async handleAgentAction(action: unknown, runId: string): Promise<void> {
    this.recorder.addEvent(runId, 'agent_action', action);
  }

  async handleAgentEnd(action: unknown, runId: string): Promise<void> {
    this.recorder.addEvent(runId, 'agent_end', action);
  }

  /** Events sent with LangChain's `dispatchCustomEvent`. */
  async handleCustomEvent(eventName: string, data: unknown, runId: string): Promise<void> {
    this.recorder.addEvent(runId, eventName, data);
  }

  private start(input: StartRunInput): Promise<void> {
    return this.recorder.start(this.withDefaultParent(input)).done;
  }

  private withDefaultParent(input: StartRunInput): StartRunInput {
    if (input.parentRunId || !this.defaultParentRunId) return input;
    return { ...input, parentRunId: this.defaultParentRunId };
  }
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
