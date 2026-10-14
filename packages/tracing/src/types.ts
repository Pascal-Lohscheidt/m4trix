/** `cancelled`: aborted before it finished (e.g. the client went away); neither a success nor a failure. */
export type TraceStatus = 'running' | 'success' | 'error' | 'cancelled';

export type TraceRunType =
  | 'agent'
  | 'chain'
  | 'llm'
  | 'chat_model'
  | 'tool'
  | 'retriever'
  | 'embedding'
  | 'prompt'
  | 'parser'
  | (string & {});

/**
 * Token usage. `input` and `output` are totals; the other counts are subsets of them, as in the
 * OpenTelemetry GenAI conventions: `cached` (cache reads) and `cacheCreation` (cache writes) are
 * part of `input`, `reasoning` is part of `output`.
 */
export type TraceTokens = {
  input: number;
  output: number;
  cached?: number;
  cacheCreation?: number;
  reasoning?: number;
};

export type TraceMetadata = Record<string, string | number | boolean>;

export type TraceAnnotation = Record<string, unknown>;

export type TraceError = {
  message: string;
  /** Error class name, e.g. `RateLimitError`. */
  type?: string;
  stack?: string;
  /** HTTP status reported by provider SDK errors. */
  status?: number;
  /** Machine-readable error code, e.g. `ECONNRESET` or `rate_limit_exceeded`. */
  code?: string;
  cause?: TraceError;
};

/** A point-in-time event inside a run, such as a custom event or an agent action. */
export type TraceEvent = {
  name: string;
  time: string;
  data?: unknown;
};

/** W3C trace context of an upstream caller this trace continues (from a `traceparent` header). */
export type RemoteParent = {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters. */
  spanId: string;
  sampled: boolean;
};

export type TraceRun = {
  schemaVersion: 1;
  traceId: string;
  runId: string;
  parentRunId?: string;
  type: TraceRunType;
  name: string;
  status: TraceStatus;
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  /** Time from run start to the first streamed token. */
  timeToFirstTokenMs?: number;
  /** Model that served the call, preferring the model the provider reported back. */
  model?: string;
  provider?: string;
  tokens?: TraceTokens;
  costUsd?: number;
  error?: TraceError;
  tags?: string[];
  inputRef?: string;
  outputRef?: string;
  /** JSON array of {@link TraceEvent}s recorded on the run. */
  eventsRef?: string;
  metadata?: TraceMetadata;
  annotation?: TraceAnnotation;
  extra?: Record<string, unknown>;
};

export type Trace = {
  schemaVersion: 1;
  traceId: string;
  rootRunId: string;
  projectId?: string;
  /** Groups the traces of one conversation or thread. */
  sessionId?: string;
  userId?: string;
  name: string;
  status: TraceStatus;
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  tokens?: TraceTokens;
  costUsd?: number;
  runCount: number;
  /** Tags of the root run. */
  tags?: string[];
  remoteParent?: RemoteParent;
  metadata?: TraceMetadata;
  annotation?: TraceAnnotation;
};

export type PatchTraceAnnotationInput = {
  traceId: string;
  annotation: TraceAnnotation;
  merge?: boolean;
};

export type PatchRunAnnotationInput = {
  traceId: string;
  runId: string;
  annotation: TraceAnnotation;
  merge?: boolean;
};

export type ListTracesQuery = {
  projectId?: string;
  sessionId?: string;
  userId?: string;
  status?: Trace['status'];
  /** Only traces carrying every one of these tags. */
  tags?: string[];
  /** Only traces at least this slow. */
  minLatencyMs?: number;
  /** Only traces costing at least this much. */
  minCostUsd?: number;
  startAfter?: string;
  startBefore?: string;
  limit?: number;
  cursor?: string;
};

export type StructureStoreAdapter = {
  upsertTrace(trace: Trace): Promise<void>;
  upsertRun(run: TraceRun): Promise<void>;
  upsertRunBatch?(runs: TraceRun[]): Promise<void>;
  getTrace(traceId: string): Promise<TraceRecord | null>;
  listTraces(query?: ListTracesQuery): Promise<ListTracesResult>;
  patchTraceAnnotation(input: PatchTraceAnnotationInput): Promise<Trace | null>;
  patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null>;
};

export type PayloadStoreAdapter = {
  putJson(path: string, value: unknown): Promise<string>;
  getJson<T = unknown>(ref: string): Promise<T>;
  putStream?(path: string, body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string>;
  getStream?(ref: string): Promise<ReadableStream<Uint8Array>>;
};

export type TraceRunNode = TraceRun & {
  children: TraceRunNode[];
};

export type ListTracesResult = {
  traces: Trace[];
  nextCursor?: string;
};

export type TraceRecord = {
  trace: Trace;
  runs: TraceRun[];
};
