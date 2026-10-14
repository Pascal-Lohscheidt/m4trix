import { otelTraceId } from './trace-context.js';
import type { RemoteParent, TraceMetadata, TraceRunType } from './types.js';

/** The root run of a trace, as seen by a {@link Sampler}. */
export type SamplingContext = {
  traceId: string;
  type: TraceRunType;
  name: string;
  metadata?: TraceMetadata;
  remoteParent?: RemoteParent;
};

/** Decides when a trace starts whether to record it. Unrecorded traces cost no storage writes. */
export type Sampler = (context: SamplingContext) => boolean;

export const alwaysSample: Sampler = () => true;

/**
 * Records about `ratio` (0..1) of traces. The decision is a hash of the OpenTelemetry trace id, the
 * id `traceparent` carries, so services that share a trace agree on it.
 */
export function ratioSampler(ratio: number): Sampler {
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new Error(`ratioSampler expects a ratio between 0 and 1, got ${ratio}`);
  }
  const threshold = Math.round(ratio * 0xffffffff);
  return (context) => {
    if (ratio === 0) return false;
    if (ratio === 1) return true;
    return fnv1a(otelTraceId(context)) <= threshold;
  };
}

/**
 * Follows the upstream caller's sampling decision when the trace continues a `traceparent`, and
 * asks `root` otherwise.
 */
export function parentBasedSampler(root: Sampler = alwaysSample): Sampler {
  return (context) => context.remoteParent?.sampled ?? root(context);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
