import type { TraceError } from './types.js';

const MAX_MESSAGE_CHARS = 4_000;
const MAX_STACK_CHARS = 8_000;
const MAX_CAUSE_DEPTH = 3;

/** Captures what is worth keeping from a thrown value, whatever was thrown. */
export function toTraceError(error: unknown, depth = 0): TraceError {
  if (!(error instanceof Error)) {
    return { message: truncate(describe(error), MAX_MESSAGE_CHARS) };
  }

  const fields = error as Error & {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    code?: unknown;
    cause?: unknown;
  };
  const status = [fields.status, fields.statusCode, fields.response?.status].find(
    (value): value is number => typeof value === 'number' && Number.isInteger(value),
  );
  const code =
    typeof fields.code === 'string' || typeof fields.code === 'number'
      ? String(fields.code)
      : undefined;
  const cause =
    fields.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? toTraceError(fields.cause, depth + 1)
      : undefined;

  return {
    message: truncate(error.message, MAX_MESSAGE_CHARS),
    ...(error.name ? { type: error.name } : {}),
    ...(error.stack ? { stack: truncate(error.stack, MAX_STACK_CHARS) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(cause ? { cause } : {}),
  };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
