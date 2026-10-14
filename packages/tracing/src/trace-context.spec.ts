import { describe, expect, it } from 'vitest';
import { formatTraceparent, otelSpanId, otelTraceId, parseTraceparent } from './trace-context.js';

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const spanId = '00f067aa0ba902b7';

describe('parseTraceparent', () => {
  it('parses a sampled and an unsampled header', () => {
    expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toEqual({
      traceId,
      spanId,
      sampled: true,
    });
    expect(parseTraceparent(`00-${traceId}-${spanId}-00`)).toEqual({
      traceId,
      spanId,
      sampled: false,
    });
  });

  it('accepts upper case and surrounding whitespace', () => {
    expect(parseTraceparent(` 00-${traceId.toUpperCase()}-${spanId}-01 `)).toMatchObject({
      traceId,
    });
  });

  it.each([
    undefined,
    '',
    'garbage',
    `ff-${traceId}-${spanId}-01`,
    `00-${'0'.repeat(32)}-${spanId}-01`,
    `00-${traceId}-${'0'.repeat(16)}-01`,
    `00-${traceId.slice(1)}-${spanId}-01`,
  ])('rejects %j', (header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it('round-trips through formatTraceparent', () => {
    const header = `00-${traceId}-${spanId}-01`;

    expect(
      formatTraceparent(parseTraceparent(header) ?? { traceId: '', spanId: '', sampled: false }),
    ).toBe(header);
  });
});

describe('otelTraceId', () => {
  it('uses a UUID trace id as hex', () => {
    expect(otelTraceId({ traceId: '4BF92F35-77B3-4DA6-A3CE-929D0E0E4736' })).toBe(traceId);
  });

  it('hashes any other id into a stable 32-hex id', () => {
    const id = otelTraceId({ traceId: 'root-run' });

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(otelTraceId({ traceId: 'root-run' })).toBe(id);
    expect(otelTraceId({ traceId: 'other-run' })).not.toBe(id);
  });

  it('continues the upstream trace when there is one', () => {
    expect(
      otelTraceId({ traceId: 'root-run', remoteParent: { traceId, spanId, sampled: true } }),
    ).toBe(traceId);
  });
});

describe('otelSpanId', () => {
  it('derives a stable, distinct 16-hex span id per run', () => {
    expect(otelSpanId('run-1')).toMatch(/^[0-9a-f]{16}$/);
    expect(otelSpanId('run-1')).toBe(otelSpanId('run-1'));
    expect(otelSpanId('run-1')).not.toBe(otelSpanId('run-2'));
  });
});
