import { describe, expect, it } from 'vitest';
import {
  isTruncatedPayload,
  type PayloadContext,
  PayloadRedactionError,
  preparePayload,
} from './payload-policy.js';

const context: PayloadContext = {
  kind: 'input',
  traceId: 'trace',
  runId: 'run',
  runType: 'chain',
  runName: 'Run',
};
const policy = { maxPayloadBytes: 1024 * 1024 };

describe('preparePayload', () => {
  it('passes plain JSON payloads through without copying them', () => {
    const payload = { messages: [{ role: 'user', content: 'hi' }] };

    expect(preparePayload(payload, context, policy)).toBe(payload);
  });

  it('marks cycles but keeps an object that is merely referenced twice', () => {
    const shared = { id: 1 };
    const payload: Record<string, unknown> = { a: shared, b: shared, nested: { list: [shared] } };
    payload.loop = { back: payload };

    expect(preparePayload(payload, context, policy)).toEqual({
      a: { id: 1 },
      b: { id: 1 },
      nested: { list: [{ id: 1 }] },
      loop: { back: '[Circular]' },
    });
  });

  it('converts BigInts and Errors, including Errors next to cycles', () => {
    const payload: Record<string, unknown> = { big: 2n ** 70n, error: new TypeError('bad') };
    payload.self = payload;

    expect(preparePayload(payload, context, policy)).toEqual({
      big: '1180591620717411303424',
      error: { name: 'TypeError', message: 'bad', stack: expect.stringContaining('TypeError') },
      self: '[Circular]',
    });
  });

  it('honours toJSON, as LangChain messages rely on it', () => {
    const payload = {
      message: { toJSON: () => ({ lc: 1, type: 'constructor', kwargs: { content: 'hi' } }) },
    };

    const prepared = preparePayload(payload, context, policy);

    // Nothing had to be rewritten, so the store serializes the original, toJSON included.
    expect(prepared).toBe(payload);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual({
      message: { lc: 1, type: 'constructor', kwargs: { content: 'hi' } },
    });
  });

  it('stores values without a JSON form as null', () => {
    expect(preparePayload(undefined, context, policy)).toBeNull();
    expect(preparePayload(() => 1, context, policy)).toBeNull();
  });

  it('truncates payloads over the limit, measuring UTF-8 bytes', () => {
    const payload = { text: 'é'.repeat(60) };

    const prepared = preparePayload(payload, context, { maxPayloadBytes: 100 });

    expect(isTruncatedPayload(prepared)).toBe(true);
    expect(prepared).toEqual({
      truncated: true,
      originalBytes: 131,
      preview: JSON.stringify(payload),
    });
    expect(preparePayload(payload, context, { maxPayloadBytes: 131 })).toBe(payload);
  });

  it('redacts before measuring and serializing', () => {
    const prepared = preparePayload({ text: 'x'.repeat(500) }, context, {
      maxPayloadBytes: 50,
      redact: (_payload, { kind }) => ({ redacted: kind }),
    });

    expect(prepared).toEqual({ redacted: 'input' });
  });

  it('wraps redactor failures so callers can tell them from serialization failures', () => {
    const failure = new Error('redactor bug');

    expect(() =>
      preparePayload({}, context, {
        ...policy,
        redact: () => {
          throw failure;
        },
      }),
    ).toThrow(expect.objectContaining({ name: 'PayloadRedactionError', cause: failure }));
    expect(() =>
      preparePayload({}, context, {
        ...policy,
        redact: () => {
          throw failure;
        },
      }),
    ).toThrow(PayloadRedactionError);
  });
});

describe('isTruncatedPayload', () => {
  it('recognizes only the truncation marker', () => {
    expect(isTruncatedPayload({ truncated: true, originalBytes: 10, preview: '' })).toBe(true);
    expect(isTruncatedPayload({ truncated: true })).toBe(false);
    expect(isTruncatedPayload('truncated')).toBe(false);
    expect(isTruncatedPayload(null)).toBe(false);
  });
});
