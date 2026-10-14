import { describe, expect, test, vi } from 'vitest';
import type { Envelope } from '../../agent-network/event-plane.js';
import { formatSSE, SSE_HEARTBEAT, toSSEStream } from './sse.js';

const envelope = (name: string, payload: unknown = { ok: true }): Envelope => ({
  name,
  meta: { runId: 'run-1', contextId: 'ctx-1', eventId: 'evt-1' },
  payload,
});

/** The SSE fields of one message, as a client would parse them. */
function fields(message: string): Array<[string, string]> {
  expect(message.endsWith('\n\n')).toBe(true);
  return message
    .slice(0, -2)
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon), line.slice(colon + 2)] as [string, string];
    });
}

const quiet = () => ({ warn: vi.fn() });

describe('formatSSE', () => {
  test('formats event and data, with an id when given', () => {
    expect(formatSSE(envelope('answer'))).toBe(
      `event: answer\ndata: ${JSON.stringify(envelope('answer'))}\n\n`,
    );
    expect(fields(formatSSE(envelope('answer'), { id: 'ctx-1/run-1/evt-1' }))).toEqual([
      ['id', 'ctx-1/run-1/evt-1'],
      ['event', 'answer'],
      ['data', JSON.stringify(envelope('answer'))],
    ]);
  });

  test('an event name with line breaks cannot inject SSE fields', () => {
    const message = formatSSE(envelope('evil\nid: forged\r\ndata: {"x":1}\revent: other'), {
      id: 'real\nretry: 1',
    });

    const parsed = fields(message);
    expect(parsed.map(([field]) => field)).toEqual(['id', 'event', 'data']);
    expect(parsed[0]?.[1]).not.toContain('\n');
    expect(parsed[1]?.[1]).not.toMatch(/[\r\n]/);
    // The original name is still in the data, JSON-escaped.
    expect(JSON.parse(parsed[2]?.[1] ?? '').name).toBe(
      'evil\nid: forged\r\ndata: {"x":1}\revent: other',
    );
  });

  test('a BigInt payload is sent with the BigInt as a string, and logged', () => {
    const logger = quiet();
    const message = formatSSE(envelope('count', { n: 10n }), { logger });

    const data = JSON.parse(fields(message)[1]?.[1] ?? '');
    expect(data.payload).toEqual({ n: '10' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not JSON-serializable'),
      expect.objectContaining({ event: 'count', runId: 'run-1' }),
    );
  });

  test('a cyclic payload is sent with the cycle cut, and logged', () => {
    const logger = quiet();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    const data = JSON.parse(fields(formatSSE(envelope('loop', cyclic), { logger }))[1]?.[1] ?? '');

    expect(data.payload).toEqual({ a: 1, self: '[Circular]' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a payload that cannot be serialized at all is replaced by an error marker', () => {
    const logger = quiet();
    const broken = {
      toJSON() {
        throw new Error('nope');
      },
    };

    const data = JSON.parse(
      fields(formatSSE(envelope('broken', broken), { logger }))[1]?.[1] ?? '',
    );

    expect(data).toEqual({
      name: 'broken',
      meta: envelope('broken').meta,
      payload: { error: 'unserializable-payload' },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('the heartbeat is an SSE comment', () => {
    expect(SSE_HEARTBEAT).toBe(': ping\n\n');
  });
});

describe('toSSEStream', () => {
  test('an unserializable payload does not end the stream', async () => {
    async function* source(): AsyncGenerator<Envelope> {
      yield envelope('first', { n: 1n });
      yield envelope('second');
    }
    const logger = quiet();

    const text = await new Response(toSSEStream(source(), undefined, { logger })).text();

    expect(text).toContain('event: first');
    expect(text).toContain('event: second');
  });
});
