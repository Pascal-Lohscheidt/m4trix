import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alwaysSample,
  parentBasedSampler,
  ratioSampler,
  type SamplingContext,
} from './sampling.js';

const root = (traceId: string, extra: Partial<SamplingContext> = {}): SamplingContext => ({
  traceId,
  type: 'chain',
  name: 'request',
  ...extra,
});

describe('ratioSampler', () => {
  it('keeps everything at 1 and nothing at 0', () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());

    expect(ids.every((id) => ratioSampler(1)(root(id)))).toBe(true);
    expect(ids.some((id) => ratioSampler(0)(root(id)))).toBe(false);
  });

  it.each([0.01, 0.1, 0.5, 0.9])('keeps about %s of random trace ids', (ratio) => {
    const sampler = ratioSampler(ratio);
    const total = 20_000;

    let kept = 0;
    for (let index = 0; index < total; index++) if (sampler(root(randomUUID()))) kept++;

    expect(Math.abs(kept / total - ratio)).toBeLessThan(0.02);
  });

  it('decides the same way every time for a trace id', () => {
    const sampler = ratioSampler(0.5);
    const ids = Array.from({ length: 100 }, () => randomUUID());

    expect(ids.map((id) => sampler(root(id)))).toEqual(ids.map((id) => sampler(root(id))));
  });

  it('agrees with services the trace continues into', () => {
    const sampler = ratioSampler(0.5);

    for (let index = 0; index < 500; index++) {
      const traceId = randomUUID();
      const remoteParent = {
        traceId: traceId.replace(/-/g, ''),
        spanId: 'b'.repeat(16),
        sampled: true,
      };
      expect(sampler(root(randomUUID(), { remoteParent }))).toBe(sampler(root(traceId)));
    }
  });

  it('decides by the upstream trace id when continuing a remote trace', () => {
    const sampler = ratioSampler(0.5);
    const upstream = 'a'.repeat(32);
    const remoteParent = { traceId: upstream, spanId: 'b'.repeat(16), sampled: true };

    const decisions = new Set(
      Array.from({ length: 50 }, () => sampler(root(randomUUID(), { remoteParent }))),
    );

    expect(decisions.size).toBe(1);
  });

  it.each([-0.1, 1.5, Number.NaN])('rejects the ratio %s', (ratio) => {
    expect(() => ratioSampler(ratio)).toThrow('between 0 and 1');
  });
});

describe('parentBasedSampler', () => {
  const remote = (sampled: boolean) => ({
    remoteParent: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled },
  });

  it('follows the upstream decision', () => {
    const sampler = parentBasedSampler(() => false);

    expect(sampler(root('t', remote(true)))).toBe(true);
    expect(parentBasedSampler(alwaysSample)(root('t', remote(false)))).toBe(false);
  });

  it('asks the root sampler for traces that start here', () => {
    expect(parentBasedSampler(() => false)(root('t'))).toBe(false);
    expect(parentBasedSampler()(root('t'))).toBe(true);
  });
});
