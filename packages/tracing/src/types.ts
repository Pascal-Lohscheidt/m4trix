export type TraceStatus = 'running' | 'success' | 'error';

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

export type TraceTokens = {
  input: number;
  output: number;
  cached?: number;
};

export type TraceMetadata = Record<string, string | number | boolean>;

export type TraceAnnotation = Record<string, unknown>;

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
  tokens?: TraceTokens;
  costUsd?: number;
  error?: { message: string; type?: string };
  inputRef?: string;
  outputRef?: string;
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
  name: string;
  status: TraceStatus;
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  tokens?: Pick<TraceTokens, 'input' | 'output'>;
  costUsd?: number;
  runCount: number;
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
  status?: Trace['status'];
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
