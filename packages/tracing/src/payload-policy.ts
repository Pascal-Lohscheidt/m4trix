import type { TraceRunType } from './types.js';

export type PayloadKind = 'input' | 'output' | 'events';

/** What a payload belongs to, handed to {@link PayloadRedactor}s. */
export type PayloadContext = {
  kind: PayloadKind;
  traceId: string;
  runId: string;
  runType: TraceRunType;
  runName: string;
};

/**
 * Returns what to store in place of `payload`, e.g. with PII removed. Runs before the payload is
 * serialized. If it throws, the payload is dropped rather than stored unredacted.
 */
export type PayloadRedactor = (payload: unknown, context: PayloadContext) => unknown;

/** Stored in place of a payload whose JSON is larger than the configured limit. */
export type TruncatedPayload = {
  truncated: true;
  originalBytes: number;
  /** The start of the payload's JSON. */
  preview: string;
};

export type PayloadPolicy = {
  redact?: PayloadRedactor;
  maxPayloadBytes: number;
};

export const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const PREVIEW_CHARS = 2048;

/**
 * Redacts and size-limits a payload and makes it JSON-safe: cycles, BigInts, and Errors would
 * otherwise make the payload store's `JSON.stringify` throw.
 */
export function preparePayload(
  payload: unknown,
  context: PayloadContext,
  policy: PayloadPolicy,
): unknown {
  let value = payload;
  if (policy.redact) {
    try {
      value = policy.redact(payload, context);
    } catch (error) {
      throw new PayloadRedactionError(error);
    }
  }
  const { json, rewritten } = toJson(value);
  const bytes = Buffer.byteLength(json, 'utf-8');
  if (bytes > policy.maxPayloadBytes) {
    return {
      truncated: true,
      originalBytes: bytes,
      preview: json.slice(0, PREVIEW_CHARS),
    } satisfies TruncatedPayload;
  }
  return rewritten ? (JSON.parse(json) as unknown) : value;
}

/** Thrown by {@link preparePayload} when the redactor fails, as opposed to serialization. */
export class PayloadRedactionError extends Error {
  constructor(readonly cause: unknown) {
    super('Payload redactor threw');
    this.name = 'PayloadRedactionError';
  }
}

export function isTruncatedPayload(value: unknown): value is TruncatedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as TruncatedPayload).truncated === true &&
    typeof (value as TruncatedPayload).originalBytes === 'number'
  );
}

/** Serializes `value`, replacing what JSON cannot hold; `rewritten` tells whether it had to. */
function toJson(value: unknown): { json: string; rewritten: boolean } {
  let rewritten = false;
  const ancestors: object[] = [];
  const json = JSON.stringify(value, function (this: unknown, _key, current: unknown) {
    // `this` is the object holding `current`; trim the stack back to it to track the current path.
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();

    if (typeof current === 'bigint') {
      rewritten = true;
      return current.toString();
    }
    let result = current;
    if (current instanceof Error) {
      rewritten = true;
      result = { name: current.name, message: current.message, stack: current.stack };
    } else if (typeof current === 'object' && current !== null && ancestors.includes(current)) {
      rewritten = true;
      return '[Circular]';
    }
    // Whatever object is returned holds the next values serialized; keep it on the path.
    if (typeof result === 'object' && result !== null) ancestors.push(result);
    return result;
  });
  // `undefined`, functions, and symbols have no JSON form; store them as null.
  if (json === undefined) return { json: 'null', rewritten: true };
  return { json, rewritten };
}
