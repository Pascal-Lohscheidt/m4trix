import { createHash } from 'node:crypto';
import type { RemoteParent } from './types.js';

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

/** Parses a W3C `traceparent` header; returns `undefined` for anything malformed. */
export function parseTraceparent(header: string | undefined): RemoteParent | undefined {
  const match = header ? TRACEPARENT.exec(header.trim().toLowerCase()) : null;
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match;
  if (version === 'ff' || traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) {
    return undefined;
  }
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(context: { traceId: string; spanId: string; sampled: boolean }) {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/**
 * The OpenTelemetry trace id of a trace: the upstream one it continues, else its own id (a UUID
 * without dashes, or a hash of any other id).
 */
export function otelTraceId(trace: { traceId: string; remoteParent?: RemoteParent }): string {
  if (trace.remoteParent) return trace.remoteParent.traceId;
  const hex = trace.traceId.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex) && hex !== INVALID_TRACE_ID) return hex;
  return hash(trace.traceId).slice(0, 32);
}

/** The OpenTelemetry span id of a run: a stable hash of its run id. */
export function otelSpanId(runId: string): string {
  const id = hash(runId).slice(0, 16);
  return id === INVALID_SPAN_ID ? '0000000000000001' : id;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
