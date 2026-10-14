import { randomUUID } from 'node:crypto';
import { addTokens, type CostCalculator } from './cost.js';
import { toTraceError } from './error-info.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  type PayloadKind,
  type PayloadPolicy,
  PayloadRedactionError,
  type PayloadRedactor,
  preparePayload,
} from './payload-policy.js';
import { alwaysSample, type Sampler } from './sampling.js';
import { formatTraceparent, otelSpanId, otelTraceId, parseTraceparent } from './trace-context.js';
import type { TraceStore } from './trace-store.js';
import type {
  RemoteParent,
  Trace,
  TraceEvent,
  TraceMetadata,
  TraceRun,
  TraceRunType,
  TraceTokens,
} from './types.js';

export type TracerOptions = {
  /**
   * Called when tracing work fails or data is dropped. Tracing never throws into the traced
   * application; this is where its failures surface. Defaults to `console.warn`, at most once a
   * minute per kind of failure.
   */
  onError?: (failure: TracerFailure) => void;
  /** Decides at each root run whether to record its trace. Defaults to recording every trace. */
  sampler?: Sampler;
  /** Rewrites payloads before they are stored, e.g. to remove PII. */
  redact?: PayloadRedactor;
  /** Payloads larger than this (as JSON) are stored as a truncated preview. Defaults to 4 MiB. */
  maxPayloadBytes?: number;
  /**
   * Upper bound on runs held in memory. When the store cannot keep up, the oldest traces are
   * dropped (and reported) instead of growing without limit: finished traces waiting to be written
   * first, running ones only if that is not enough. Defaults to 10 000.
   */
  maxBufferedRuns?: number;
  /** Events kept per run; later ones are counted and dropped. Defaults to 1 000. */
  maxEventsPerRun?: number;
  /** Prices model calls that report tokens but no cost. */
  cost?: CostCalculator;
  /**
   * Flush on its own once a trace has finished, and retry failed flushes with backoff (1 s up to
   * 30 s). Defaults to `true`.
   */
  autoFlush?: boolean;
};

export type TracerFailureKind = 'payload' | 'redact' | 'flush' | 'dropped' | 'hook' | 'internal';

export type TracerFailure = {
  kind: TracerFailureKind;
  message: string;
  error?: unknown;
  traceId?: string;
  runId?: string;
};

export type TracerStats = {
  /** Traces held in memory: running, or finished but not yet written. */
  activeTraces: number;
  /** Runs held in memory. */
  bufferedRuns: number;
  /** Runs waiting for the next flush. */
  pendingRuns: number;
  droppedTraces: number;
  droppedRuns: number;
  droppedEvents: number;
  sampledOutTraces: number;
  failedFlushes: number;
  failedPayloads: number;
};

export type StartRunInput = {
  /** Defaults to a new UUID. */
  runId?: string;
  parentRunId?: string;
  type: TraceRunType;
  name: string;
  input?: unknown;
  /** Scalar values are kept; `projectId`, `sessionId`, `userId` and `traceparent` are lifted out. */
  metadata?: Record<string, unknown>;
  tags?: string[];
  model?: string;
  provider?: string;
  extra?: Record<string, unknown>;
  /** Root runs only: overrides the matching `metadata` keys. */
  projectId?: string;
  sessionId?: string;
  userId?: string;
  /** Root runs only: W3C `traceparent` of an upstream caller this trace continues. */
  traceparent?: string;
};

export type EndRunInput = {
  output?: unknown;
  /** Ends the run as failed. */
  error?: unknown;
  /** Ends the run as cancelled (aborted, not failed). Ignored when `error` is set. */
  cancelled?: boolean;
  tokens?: TraceTokens;
  /** The model that served the call, if it differs from the one given at start. */
  model?: string;
  /** Overrides the {@link TracerOptions.cost} calculator. */
  costUsd?: number;
};

/** A started run. Every method is safe to call more than once and never throws. */
export type RunHandle = {
  readonly runId: string;
  /** `false` when the run's trace was sampled out, so nothing about it is stored. */
  readonly recorded: boolean;
  end(result?: EndRunInput): Promise<void>;
  addEvent(name: string, data?: unknown): void;
  /** `traceparent` header for calls this run makes to other services. */
  traceparent(): string | undefined;
};

type RunState = {
  run: TraceRun;
  startedAtMs: number;
  started: Promise<void>;
  events: TraceEvent[];
  ended: boolean;
  firstTokenAtMs?: number;
};

type RootAttributes = {
  projectId?: string;
  sessionId?: string;
  userId?: string;
  remoteParent?: RemoteParent;
};

type TraceState = {
  runs: Map<string, RunState>;
  running: number;
  rootRunId?: string;
  root?: RootAttributes;
};

const DEFAULT_MAX_BUFFERED_RUNS = 10_000;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const WARN_INTERVAL_MS = 60_000;
const DEFAULT_MAX_EVENTS_PER_RUN = 1_000;
const MAX_UNSAMPLED_RUNS = 100_000;
const LIFTED_METADATA_KEYS = new Set(['projectId', 'sessionId', 'userId', 'traceparent']);

/**
 * Framework-neutral core of the tracer: turns run starts and ends into trace records and writes
 * them to a {@link TraceStore}. Nothing here throws or rejects into the caller; failures go to
 * `onError` and are counted in {@link TracerStats}.
 *
 * A trace stays in memory until none of its runs is running and a flush has written it.
 */
export class TraceRecorder {
  private readonly traces = new Map<string, TraceState>();
  private readonly runTraceIds = new Map<string, string>();
  private readonly pendingRuns = new Map<string, TraceRun>();
  private readonly dirtyTraceIds = new Set<string>();
  /** Runs of sampled-out traces, with the OpenTelemetry trace id they would have had. */
  private readonly unsampledRuns = new Map<string, string>();
  private readonly inFlight = new Set<Promise<void>>();
  private flushQueue: Promise<void> = Promise.resolve();
  private bufferedRuns = 0;
  private retryDelayMs = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onError: (failure: TracerFailure) => void;
  private readonly sampler: Sampler;
  private readonly payloadPolicy: PayloadPolicy;
  private readonly maxBufferedRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly cost: CostCalculator | undefined;
  private readonly autoFlush: boolean;
  private readonly counters = {
    droppedTraces: 0,
    droppedRuns: 0,
    droppedEvents: 0,
    sampledOutTraces: 0,
    failedFlushes: 0,
    failedPayloads: 0,
  };

  constructor(
    private readonly traceStore: TraceStore,
    options: TracerOptions = {},
  ) {
    this.onError = options.onError ?? throttledWarn();
    this.sampler = options.sampler ?? alwaysSample;
    this.payloadPolicy = {
      redact: options.redact,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    };
    this.maxBufferedRuns = Math.max(1, options.maxBufferedRuns ?? DEFAULT_MAX_BUFFERED_RUNS);
    this.maxEventsPerRun = Math.max(0, options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN);
    this.cost = options.cost;
    this.autoFlush = options.autoFlush ?? true;
  }

  stats(): TracerStats {
    return {
      activeTraces: this.traces.size,
      bufferedRuns: this.bufferedRuns,
      pendingRuns: this.pendingRuns.size,
      ...this.counters,
    };
  }

  /** Starts a run; `done` settles once its input is stored. */
  start(input: StartRunInput): { handle: RunHandle; done: Promise<void> } {
    const runId = input.runId ?? randomUUID();
    try {
      const recorded = this.startRun(runId, input);
      return {
        handle: this.handle(runId, recorded),
        done: recorded ? this.readiness(runId) : done,
      };
    } catch (error) {
      this.report({ kind: 'internal', message: 'Failed to start a run', error, runId });
      return { handle: this.handle(runId, false), done };
    }
  }

  end(runId: string, result: EndRunInput = {}): Promise<void> {
    return this.track(
      this.endRun(runId, result).catch((error: unknown) => {
        this.report({ kind: 'internal', message: 'Failed to end a run', error, runId });
      }),
    );
  }

  addEvent(runId: string, name: string, data?: unknown): void {
    const runState = this.locate(runId)?.runState;
    if (!runState || runState.ended) return;
    if (runState.events.length >= this.maxEventsPerRun) {
      this.counters.droppedEvents += 1;
      return;
    }
    runState.events.push({ name, time: new Date().toISOString(), data });
  }

  markFirstToken(runId: string): void {
    const runState = this.locate(runId)?.runState;
    if (runState && runState.firstTokenAtMs === undefined) runState.firstTokenAtMs = Date.now();
  }

  traceparent(runId: string): string | undefined {
    // Sampled-out runs still propagate, so services downstream can follow the decision.
    const unsampledTraceId = this.unsampledRuns.get(runId);
    if (unsampledTraceId) {
      return formatTraceparent({
        traceId: unsampledTraceId,
        spanId: otelSpanId(runId),
        sampled: false,
      });
    }
    const located = this.locate(runId);
    if (!located) return undefined;
    const { state, traceId } = located;
    return formatTraceparent({
      traceId: otelTraceId({ traceId, remoteParent: state.root?.remoteParent }),
      spanId: otelSpanId(runId),
      sampled: true,
    });
  }

  /**
   * Writes pending runs and traces. Flushes run one at a time so an older snapshot can never land
   * after a newer one; records from a failed flush are queued again for the next one.
   */
  flush(): Promise<void> {
    const flushed = this.flushQueue
      .then(() => this.flushPending())
      .catch((error: unknown) => {
        this.report({ kind: 'internal', message: 'Flush failed unexpectedly', error });
      });
    this.flushQueue = flushed;
    return flushed;
  }

  private startRun(runId: string, input: StartRunInput): boolean {
    if (this.runTraceIds.has(runId)) return true;
    const unsampledParent = input.parentRunId && this.unsampledRuns.get(input.parentRunId);
    if (unsampledParent) {
      this.markUnsampled(runId, unsampledParent);
      return false;
    }

    const parentTraceId = input.parentRunId ? this.runTraceIds.get(input.parentRunId) : undefined;
    // A parent we never saw is usually a root already released from memory, and a root's run id
    // is its trace id; anything else still lands in the store under that id.
    const traceId = parentTraceId ?? input.parentRunId ?? runId;
    const metadata = toTraceMetadata(input.metadata);
    const root = input.parentRunId ? undefined : readRootAttributes(input);

    if (root && !this.sample({ traceId, input, metadata, remoteParent: root.remoteParent })) {
      this.counters.sampledOutTraces += 1;
      this.markUnsampled(runId, otelTraceId({ traceId, remoteParent: root.remoteParent }));
      return false;
    }

    let state = this.traces.get(traceId);
    if (!state) {
      state = { runs: new Map(), running: 0 };
      this.traces.set(traceId, state);
    }
    if (root) {
      state.rootRunId = runId;
      state.root = root;
    }

    const run: TraceRun = {
      schemaVersion: 1,
      traceId,
      runId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      type: input.type,
      name: input.name || input.type,
      status: 'running',
      startTime: new Date().toISOString(),
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
      ...(metadata ? { metadata } : {}),
      ...(input.extra && Object.keys(input.extra).length > 0 ? { extra: input.extra } : {}),
    };
    const runState: RunState = {
      run,
      startedAtMs: Date.now(),
      started: done,
      events: [],
      ended: false,
    };
    state.runs.set(runId, runState);
    state.running += 1;
    this.runTraceIds.set(runId, traceId);
    this.bufferedRuns += 1;
    this.markPending(traceId, run);

    if (input.input !== undefined) {
      runState.started = this.track(
        this.storePayload(run, 'input', input.input).then((inputRef) => {
          if (inputRef) this.update(traceId, runState, { ...runState.run, inputRef });
        }),
      );
    }

    this.enforceBufferLimit(traceId);
    return true;
  }

  private async endRun(runId: string, result: EndRunInput): Promise<void> {
    if (this.unsampledRuns.delete(runId)) return;
    const located = this.locate(runId);
    if (!located || located.runState.ended) return;
    const { runState, state, traceId } = located;
    runState.ended = true;
    state.running -= 1;
    const endedAtMs = Date.now();

    await runState.started;
    const failed = result.error !== undefined;
    const [outputRef, eventsRef] = await Promise.all([
      result.output === undefined
        ? undefined
        : this.storePayload(runState.run, 'output', result.output),
      runState.events.length === 0
        ? undefined
        : this.storePayload(runState.run, 'events', runState.events),
    ]);

    const current = runState.run;
    const model = result.model ?? current.model;
    const costUsd = result.costUsd ?? this.price(current, model, result.tokens);
    this.update(traceId, runState, {
      ...current,
      status: failed ? 'error' : result.cancelled ? 'cancelled' : 'success',
      endTime: new Date(endedAtMs).toISOString(),
      latencyMs: endedAtMs - runState.startedAtMs,
      ...(runState.firstTokenAtMs !== undefined
        ? { timeToFirstTokenMs: runState.firstTokenAtMs - runState.startedAtMs }
        : {}),
      ...(model ? { model } : {}),
      ...(result.tokens ? { tokens: result.tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(outputRef ? { outputRef } : {}),
      ...(eventsRef ? { eventsRef } : {}),
      ...(failed ? { error: toTraceError(result.error) } : {}),
    });

    // While a failed flush waits for its retry, finished traces join that retry.
    if (
      this.autoFlush &&
      state.running === 0 &&
      state.rootRunId !== undefined &&
      !this.retryTimer
    ) {
      void this.flush();
    }
  }

  private async flushPending(): Promise<void> {
    await Promise.all([...this.inFlight]);

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
      this.counters.failedFlushes += 1;
      this.report({ kind: 'flush', message: 'Failed to write traces; will retry', error });
      this.scheduleRetry();
      return;
    }

    // Writing works again: stop backing off, and let finished traces flush right away.
    this.retryDelayMs = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.releaseFinished(traceIds);
  }

  /** Retries a failed flush with exponential backoff, without keeping the process alive. */
  private scheduleRetry(): void {
    if (!this.autoFlush || this.retryTimer) return;
    this.retryDelayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      Math.max(MIN_RETRY_DELAY_MS, this.retryDelayMs * 2),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }

  /** Puts records back unless a newer version was queued while the failed write was in flight. */
  private requeue(runs: TraceRun[], traceIds: string[]): void {
    for (const run of runs) {
      if (!this.traces.has(run.traceId) || this.pendingRuns.has(run.runId)) continue;
      this.pendingRuns.set(run.runId, run);
    }
    for (const traceId of traceIds) {
      if (this.traces.has(traceId)) this.dirtyTraceIds.add(traceId);
    }
  }

  /** Drops written traces that have no running runs and no changes since they were written. */
  private releaseFinished(traceIds: string[]): void {
    for (const traceId of traceIds) {
      const state = this.traces.get(traceId);
      if (!state || state.running > 0 || this.dirtyTraceIds.has(traceId)) continue;
      this.forget(traceId, state);
    }
  }

  /**
   * Drops the oldest traces once more runs are buffered than allowed. Finished traces waiting to
   * be written go first: they are what piles up while the store is down. Running traces are only
   * dropped when that is not enough, and the trace being recorded never is.
   */
  private enforceBufferLimit(currentTraceId: string): void {
    for (const finished of [true, false]) {
      for (const [traceId, state] of this.traces) {
        if (this.bufferedRuns <= this.maxBufferedRuns) return;
        if (traceId === currentTraceId || (state.running === 0) !== finished) continue;
        this.drop(traceId, state);
      }
    }
  }

  private drop(traceId: string, state: TraceState): void {
    this.forget(traceId, state);
    for (const runId of state.runs.keys()) this.pendingRuns.delete(runId);
    this.dirtyTraceIds.delete(traceId);
    this.counters.droppedTraces += 1;
    this.counters.droppedRuns += state.runs.size;
    this.report({
      kind: 'dropped',
      message: `Dropped ${state.running > 0 ? 'running' : 'finished'} trace with ${state.runs.size} runs: more than ${this.maxBufferedRuns} runs buffered`,
      traceId,
    });
  }

  private forget(traceId: string, state: TraceState): void {
    this.traces.delete(traceId);
    this.bufferedRuns -= state.runs.size;
    for (const runId of state.runs.keys()) this.runTraceIds.delete(runId);
  }

  /** Records a newer snapshot of a run, unless its trace was dropped in the meantime. */
  private update(traceId: string, runState: RunState, run: TraceRun): void {
    if (this.traces.get(traceId)?.runs.get(run.runId) !== runState) return;
    runState.run = run;
    this.markPending(traceId, run);
  }

  private markPending(traceId: string, run: TraceRun): void {
    this.pendingRuns.set(run.runId, run);
    this.dirtyTraceIds.add(traceId);
  }

  /** Summarizes a trace from its root run, adding up usage and cost across all runs. */
  private buildTrace(traceId: string): Trace | undefined {
    const state = this.traces.get(traceId);
    const root = state?.rootRunId ? state.runs.get(state.rootRunId)?.run : undefined;
    if (!state || !root) return undefined;

    let tokens: TraceTokens | undefined;
    let costUsd: number | undefined;
    let failed = false;
    for (const { run } of state.runs.values()) {
      if (run.tokens) tokens = addTokens(tokens, run.tokens);
      if (run.costUsd !== undefined) costUsd = (costUsd ?? 0) + run.costUsd;
      if (run.status === 'error') failed = true;
    }
    const attributes = state.root ?? {};

    return {
      schemaVersion: 1,
      traceId,
      rootRunId: root.runId,
      ...(attributes.projectId ? { projectId: attributes.projectId } : {}),
      ...(attributes.sessionId ? { sessionId: attributes.sessionId } : {}),
      ...(attributes.userId ? { userId: attributes.userId } : {}),
      name: root.name,
      status: failed ? 'error' : root.status,
      startTime: root.startTime,
      ...(root.endTime ? { endTime: root.endTime } : {}),
      ...(root.latencyMs !== undefined ? { latencyMs: root.latencyMs } : {}),
      ...(tokens ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      runCount: state.runs.size,
      ...(root.tags ? { tags: root.tags } : {}),
      ...(attributes.remoteParent ? { remoteParent: attributes.remoteParent } : {}),
      ...(root.metadata ? { metadata: root.metadata } : {}),
    };
  }

  /** Stores a payload under the policy; returns its ref, or `undefined` if it was not stored. */
  private async storePayload(
    run: TraceRun,
    kind: PayloadKind,
    payload: unknown,
  ): Promise<string | undefined> {
    const ids = { traceId: run.traceId, runId: run.runId };
    let value: unknown;
    try {
      value = preparePayload(
        payload,
        { kind, ...ids, runType: run.type, runName: run.name },
        this.payloadPolicy,
      );
    } catch (error) {
      this.counters.failedPayloads += 1;
      this.report(
        error instanceof PayloadRedactionError
          ? {
              kind: 'redact',
              message: `Dropped ${kind} payload: redaction failed`,
              error: error.cause,
              ...ids,
            }
          : { kind: 'payload', message: `Could not serialize ${kind} payload`, error, ...ids },
      );
      return undefined;
    }

    try {
      return await this.traceStore.putJsonPayload(payloadPath(run, kind), value);
    } catch (error) {
      this.counters.failedPayloads += 1;
      this.report({ kind: 'payload', message: `Failed to store ${kind} payload`, error, ...ids });
      return undefined;
    }
  }

  private sample(context: {
    traceId: string;
    input: StartRunInput;
    metadata: TraceMetadata | undefined;
    remoteParent: RemoteParent | undefined;
  }): boolean {
    try {
      return this.sampler({
        traceId: context.traceId,
        type: context.input.type,
        name: context.input.name,
        ...(context.metadata ? { metadata: context.metadata } : {}),
        ...(context.remoteParent ? { remoteParent: context.remoteParent } : {}),
      });
    } catch (error) {
      this.report({ kind: 'hook', message: 'Sampler threw; recording the trace', error });
      return true;
    }
  }

  private price(run: TraceRun, model: string | undefined, tokens: TraceTokens | undefined) {
    if (!this.cost || !tokens) return undefined;
    try {
      const usd = this.cost({ model, provider: run.provider, tokens });
      return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined;
    } catch (error) {
      this.report({
        kind: 'hook',
        message: 'Cost calculator threw',
        error,
        traceId: run.traceId,
        runId: run.runId,
      });
      return undefined;
    }
  }

  private markUnsampled(runId: string, otelTraceIdOfRun: string): void {
    this.unsampledRuns.set(runId, otelTraceIdOfRun);
    if (this.unsampledRuns.size > MAX_UNSAMPLED_RUNS) {
      const oldest = this.unsampledRuns.keys().next().value;
      if (oldest !== undefined) this.unsampledRuns.delete(oldest);
    }
  }

  private locate(
    runId: string,
  ): { traceId: string; state: TraceState; runState: RunState } | undefined {
    const traceId = this.runTraceIds.get(runId);
    const state = traceId === undefined ? undefined : this.traces.get(traceId);
    const runState = state?.runs.get(runId);
    return traceId !== undefined && state && runState ? { traceId, state, runState } : undefined;
  }

  private readiness(runId: string): Promise<void> {
    return this.locate(runId)?.runState.started ?? done;
  }

  private handle(runId: string, recorded: boolean): RunHandle {
    return {
      runId,
      recorded,
      end: (result) => this.end(runId, result),
      addEvent: (name, data) => this.addEvent(runId, name, data),
      traceparent: () => this.traceparent(runId),
    };
  }

  private track(promise: Promise<void>): Promise<void> {
    this.inFlight.add(promise);
    return promise.finally(() => {
      this.inFlight.delete(promise);
    });
  }

  private report(failure: TracerFailure): void {
    try {
      this.onError(failure);
    } catch {
      // A failing error handler must not break tracing either.
    }
  }
}

const done = Promise.resolve();

function readRootAttributes(input: StartRunInput): RootAttributes {
  const metadata = input.metadata ?? {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;
  const projectId = text(input.projectId) ?? text(metadata.projectId);
  // LangGraph puts `configurable.thread_id` into metadata; a thread is a session.
  const sessionId = text(input.sessionId) ?? text(metadata.sessionId) ?? text(metadata.thread_id);
  const userId = text(input.userId) ?? text(metadata.userId);
  const remoteParent = parseTraceparent(text(input.traceparent) ?? text(metadata.traceparent));
  return {
    ...(projectId ? { projectId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(userId ? { userId } : {}),
    ...(remoteParent ? { remoteParent } : {}),
  };
}

function toTraceMetadata(metadata: Record<string, unknown> | undefined): TraceMetadata | undefined {
  if (!metadata) return undefined;

  const entries = Object.entries(metadata).filter(
    (entry): entry is [string, string | number | boolean] =>
      !LIFTED_METADATA_KEYS.has(entry[0]) &&
      (typeof entry[1] === 'string' ||
        typeof entry[1] === 'number' ||
        typeof entry[1] === 'boolean'),
  );

  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function payloadPath(run: TraceRun, kind: PayloadKind): string {
  return `traces/${run.traceId}/payloads/${run.runId}/${kind}.json`;
}

/** `console.warn`, at most once a minute per failure kind, counting what it held back. */
function throttledWarn(): (failure: TracerFailure) => void {
  const last = new Map<TracerFailureKind, { at: number; suppressed: number }>();
  return (failure) => {
    const now = Date.now();
    const previous = last.get(failure.kind);
    if (previous && now - previous.at < WARN_INTERVAL_MS) {
      previous.suppressed += 1;
      return;
    }
    last.set(failure.kind, { at: now, suppressed: 0 });
    const held = previous?.suppressed ? ` (${previous.suppressed} similar failures not shown)` : '';
    console.warn(`[m4trix/tracing] ${failure.message}${held}`, failure.error ?? '');
  };
}
