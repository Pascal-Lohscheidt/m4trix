import { describe, expect, it } from 'vitest';
import { toTraceError } from './error-info.js';

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

describe('toTraceError', () => {
  it('keeps type, stack, HTTP status, code, and the cause chain', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const error = new ProviderError('429 Too Many Requests', 429, 'rate_limit_exceeded', cause);

    expect(toTraceError(error)).toEqual({
      message: '429 Too Many Requests',
      type: 'RateLimitError',
      stack: expect.stringContaining('RateLimitError: 429 Too Many Requests'),
      status: 429,
      code: 'rate_limit_exceeded',
      cause: {
        message: 'socket hang up',
        type: 'Error',
        stack: expect.any(String),
        code: 'ECONNRESET',
      },
    });
  });

  it('reads the status from statusCode or response.status', () => {
    expect(toTraceError(Object.assign(new Error('x'), { statusCode: 503 }))).toMatchObject({
      status: 503,
    });
    expect(
      toTraceError(Object.assign(new Error('x'), { response: { status: 401 } })),
    ).toMatchObject({
      status: 401,
    });
    expect(toTraceError(Object.assign(new Error('x'), { status: 'bad' }))).not.toHaveProperty(
      'status',
    );
  });

  it('describes thrown values that are not Errors', () => {
    expect(toTraceError('plain string')).toEqual({ message: 'plain string' });
    expect(toTraceError({ reason: 'nope' })).toEqual({ message: '{"reason":"nope"}' });
    expect(toTraceError(undefined)).toEqual({ message: 'undefined' });
  });

  it('stops following causes after a few levels, even for cycles', () => {
    const error = new Error('outer');
    (error as { cause?: unknown }).cause = error;

    let depth = 0;
    for (let current = toTraceError(error); current.cause; current = current.cause) depth++;

    expect(depth).toBe(3);
  });

  it('truncates huge messages', () => {
    const traced = toTraceError(new Error('x'.repeat(10_000)));

    expect(traced.message.length).toBeLessThanOrEqual(4_001);
  });
});
