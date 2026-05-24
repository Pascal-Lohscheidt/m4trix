export type TraceMetadata = Record<string, string | number | boolean>;
export type TraceAnnotation = Record<string, unknown>;

export type TraceRow = {
  traceId: string;
  name: string;
  status: string;
  startTime: string;
  runCount: number;
  projectId?: string;
  metadata?: TraceMetadata;
  annotation?: TraceAnnotation;
};

export type RunNode = {
  runId: string;
  parentRunId?: string;
  name: string;
  type: string;
  status: string;
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  tokens?: { input: number; output: number; cached?: number };
  costUsd?: number;
  error?: { message: string; type?: string };
  inputRef?: string;
  outputRef?: string;
  metadata?: TraceMetadata;
  annotation?: TraceAnnotation;
  children: RunNode[];
};

export type TraceTree = {
  trace: TraceRow;
  root: RunNode;
};

export type TraceFilters = {
  env: string;
  status: string;
  projectId: string;
  query: string;
};
