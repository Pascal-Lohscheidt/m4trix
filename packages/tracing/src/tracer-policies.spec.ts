import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTruncatedPayload,
  type PayloadContext,
  parentBasedSampler,
  ratioSampler,
  Tracer,
  type TracerFailure,
  type TracerOptions,
} from './index.js';
import { recordingTraceStore } from './testing/recording-stores.js';

function setup(options: TracerOptions = {}) {
  const store = recordingTraceStore();
  const failures: TracerFailure[] = [];
  const tracer = Tracer.from(store.traceStore, {
    onError: (failure) => failures.push(failure),
    ...options,
  });
  return { ...store, tracer, failures };
}

describe('Tracer fails open', () => {
  it('keeps recording runs when payloads cannot be stored', async () => {
    const { tracer, structure, payloads, failures } = setup();
    payloads.unavailable = true;

    await expect(tracer.handleChainStart({}, { q: 1 }, 'root')).resolves.toBeUndefined();
    await expect(tracer.handleChainEnd({ a: 1 }, 'root')).resolves.toBeUndefined();
    await tracer.flush();

    expect(structure.run('root')).toMatchObject({ status: 'success' });
    expect(structure.run('root')).not.toHaveProperty('inputRef');
    expect(structure.run('root')).not.toHaveProperty('outputRef');
    expect(failures.map((failure) => failure.kind)).toEqual(['payload', 'payload']);
    expect(failures[0]).toMatchObject({ traceId: 'root', runId: 'root' });
    expect(tracer.stats().failedPayloads).toBe(2);
  });

  it('never rejects a flush, and writes everything once the store recovers', async () => {
    const { tracer, structure, failures } = setup({ autoFlush: false });
    structure.unavailable = true;

    await tracer.handleChainStart({}, {}, 'root');
    await tracer.handleChainEnd({}, 'root');
    await expect(tracer.flush()).resolves.toBeUndefined();
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(failures.map((failure) => failure.kind)).toEqual(['flush', 'flush']);

    structure.unavailable = false;
    await tracer.flush();

    expect(structure.trace('root')).toMatchObject({ status: 'success' });
    expect(tracer.stats()).toMatchObject({ failedFlushes: 2, activeTraces: 0, pendingRuns: 0 });
  });

  it('serializes payloads JSON cannot hold instead of throwing', async () => {
    const { tracer, payloads } = setup();
    const input: Record<string, unknown> = { count: 10n, error: new Error('boom') };
    input.self = input;

    await tracer.handleChainStart({}, input, 'root');
    await tracer.flush();

    expect(payloads.payloads.get('traces/root/payloads/root/input.json')).toMatchObject({
      count: '10',
      error: { name: 'Error', message: 'boom' },
      self: '[Circular]',
    });
  });

  it('survives an error handler that throws', async () => {
    const { traceStore, payloads } = recordingTraceStore();
    payloads.unavailable = true;
    const tracer = Tracer.from(traceStore, {
      onError: () => {
        throw new Error('handler broke');
      },
    });

    await expect(tracer.handleChainStart({}, {}, 'root')).resolves.toBeUndefined();
  });

  it('keeps flushing after a flush failed unexpectedly', async () => {
    const { tracer, traceStore, structure, failures } = setup({ autoFlush: false });
    const upsertRunBatch = vi.spyOn(traceStore, 'upsertRunBatch').mockImplementationOnce(() => {
      throw new TypeError('bug outside the store');
    });

    await tracer.handleChainStart({}, {}, 'root');
    await tracer.handleChainEnd({}, 'root');
    await expect(tracer.flush()).resolves.toBeUndefined();
    await tracer.flush();

    expect(upsertRunBatch).toHaveBeenCalledTimes(2);
    expect(failures.map((failure) => failure.kind)).toEqual(['flush']);
    expect(structure.trace('root')).toMatchObject({ status: 'success' });
  });

  it('ignores ends and events for runs it never saw', async () => {
    const { tracer, structure } = setup();

    await expect(tracer.handleChainEnd({}, 'unknown')).resolves.toBeUndefined();
    tracer.addEvent('unknown', 'event');
    await tracer.flush();

    expect(structure.batches).toEqual([]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Tracer during a store outage', () => {
  it('retries with backoff instead of re-sending the backlog for every finished trace', async () => {
    vi.useFakeTimers();
    const { tracer, structure } = setup();
    structure.unavailable = true;
    const writes = vi.spyOn(structure, 'upsertRunBatch');

    for (let index = 0; index < 50; index++) {
      await tracer.startRun({ type: 'chain', name: `request-${index}` }).end();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toHaveBeenCalledTimes(2);

    structure.unavailable = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveBeenCalledTimes(3);
    expect(new Set(structure.traces.map((trace) => trace.traceId)).size).toBe(50);
    expect(tracer.stats()).toMatchObject({ activeTraces: 0, failedFlushes: 2 });

    // Back to normal: the next finished trace is written right away.
    await tracer.startRun({ type: 'chain', name: 'after' }).end();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveBeenCalledTimes(4);
  });

  it('stops backing off as soon as an explicit flush gets through', async () => {
    vi.useFakeTimers();
    const { tracer, structure } = setup();
    structure.unavailable = true;
    await tracer.startRun({ type: 'chain', name: 'during' }).end();
    await vi.advanceTimersByTimeAsync(0);

    structure.unavailable = false;
    await tracer.flush();
    await tracer.startRun({ type: 'chain', name: 'after' }).end();
    await vi.advanceTimersByTimeAsync(0);

    expect(structure.traces.map((trace) => trace.name)).toEqual(['during', 'after']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('warns at most once a minute per kind of failure by default', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { traceStore, structure } = recordingTraceStore();
    structure.unavailable = true;
    const tracer = Tracer.from(traceStore, { autoFlush: false });

    await tracer.startRun({ type: 'chain', name: 'request' }).end();
    for (let index = 0; index < 5; index++) await tracer.flush();
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await tracer.flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('4 similar failures not shown');
  });
});

describe('Tracer memory bound', () => {
  it('drops the oldest traces instead of growing while the store is down', async () => {
    const { tracer, structure, failures } = setup({ maxBufferedRuns: 4, autoFlush: false });
    structure.unavailable = true;

    for (let index = 0; index < 5; index++) {
      await tracer.handleChainStart({}, {}, `root-${index}`);
      await tracer.handleToolStart({}, 'q', `tool-${index}`, `root-${index}`);
      await tracer.handleToolEnd({}, `tool-${index}`);
      await tracer.handleChainEnd({}, `root-${index}`);
      await tracer.flush();
    }

    expect(tracer.stats()).toMatchObject({
      activeTraces: 2,
      bufferedRuns: 4,
      droppedTraces: 3,
      droppedRuns: 6,
    });
    expect(failures.filter((failure) => failure.kind === 'dropped').map((f) => f.traceId)).toEqual([
      'root-0',
      'root-1',
      'root-2',
    ]);

    structure.unavailable = false;
    await tracer.flush();
    expect(structure.traces.map((trace) => trace.traceId).sort()).toEqual(['root-3', 'root-4']);
  });

  it('drops finished traces waiting to be written before running ones', async () => {
    const { tracer, structure, failures } = setup({ maxBufferedRuns: 4, autoFlush: false });
    structure.unavailable = true;

    const live = tracer.startRun({ type: 'chain', name: 'live' });
    tracer.startRun({ type: 'tool', name: 'live-tool', parentRunId: live.runId });
    await tracer.startRun({ type: 'chain', name: 'finished' }).end();
    const next = tracer.startRun({ type: 'chain', name: 'next' });
    tracer.startRun({ type: 'tool', name: 'next-tool', parentRunId: next.runId });

    expect(failures.filter((failure) => failure.kind === 'dropped')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('finished trace') }),
    ]);
    expect(tracer.stats()).toMatchObject({ activeTraces: 2, bufferedRuns: 4, droppedTraces: 1 });
  });

  it('never drops the trace that is being recorded', async () => {
    const { tracer } = setup({ maxBufferedRuns: 2, autoFlush: false });

    await tracer.handleChainStart({}, {}, 'root');
    for (let index = 0; index < 4; index++) {
      await tracer.handleToolStart({}, 'q', `tool-${index}`, 'root');
    }

    expect(tracer.stats()).toMatchObject({ activeTraces: 1, bufferedRuns: 5, droppedTraces: 0 });
  });
});

describe('Tracer payload policy', () => {
  it('stores what the redactor returns, telling it what each payload is', async () => {
    const contexts: PayloadContext[] = [];
    const { tracer, payloads } = setup({
      redact: (payload, context) => {
        contexts.push(context);
        return JSON.parse(JSON.stringify(payload).replace(/alice@example\.com/g, '[email]'));
      },
    });

    await tracer.handleChainStart(
      {},
      { email: 'alice@example.com' },
      'root',
      undefined,
      [],
      {},
      'chain',
      'Root',
    );
    tracer.addEvent('root', 'lookup', { email: 'alice@example.com' });
    await tracer.handleChainEnd({ reply: 'mailed alice@example.com' }, 'root');
    await tracer.flush();

    const stored = JSON.stringify([...payloads.payloads.values()]);
    expect(stored).not.toContain('alice@example.com');
    expect(payloads.payloads.get('traces/root/payloads/root/input.json')).toEqual({
      email: '[email]',
    });
    expect(contexts.map((context) => context.kind).sort()).toEqual(['events', 'input', 'output']);
    expect(contexts[0]).toMatchObject({
      traceId: 'root',
      runId: 'root',
      runType: 'chain',
      runName: 'Root',
    });
  });

  it('drops a payload rather than storing it unredacted when the redactor throws', async () => {
    const { tracer, structure, payloads, failures } = setup({
      redact: () => {
        throw new Error('redactor bug');
      },
    });

    await tracer.handleChainStart({}, { secret: 'value' }, 'root');
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    expect(payloads.payloads.size).toBe(0);
    expect(structure.run('root')).toMatchObject({ status: 'success' });
    expect(failures.map((failure) => failure.kind)).toEqual(['redact', 'redact']);
  });

  it('stores a truncated preview of payloads over the size limit', async () => {
    const { tracer, payloads } = setup({ maxPayloadBytes: 100 });

    await tracer.handleChainStart({}, { text: 'x'.repeat(500) }, 'root');
    await tracer.handleChainEnd({ ok: true }, 'root');
    await tracer.flush();

    const input = payloads.payloads.get('traces/root/payloads/root/input.json');
    expect(isTruncatedPayload(input)).toBe(true);
    expect(input).toMatchObject({ truncated: true, originalBytes: 511 });
    expect((input as { preview: string }).preview.startsWith('{"text":"xxx')).toBe(true);
    expect(payloads.payloads.get('traces/root/payloads/root/output.json')).toEqual({ ok: true });
  });
});

describe('Tracer sampling', () => {
  it('records nothing for a sampled-out trace, including its child runs and events', async () => {
    const { tracer, structure, payloads } = setup({ sampler: () => false });

    await tracer.handleChainStart({}, {}, 'root');
    await tracer.handleChatModelStart({}, [], 'llm', 'root');
    await tracer.handleToolStart({}, 'q', 'tool', 'llm');
    tracer.addEvent('tool', 'event');
    await tracer.handleToolEnd({}, 'tool');
    await tracer.handleLLMEnd({}, 'llm');
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    expect(structure.batches).toEqual([]);
    expect(payloads.payloads.size).toBe(0);
    expect(tracer.stats()).toMatchObject({ sampledOutTraces: 1, activeTraces: 0 });
  });

  it('asks the sampler once per trace, with the root run', async () => {
    const sampler = vi.fn(() => true);
    const { tracer } = setup({ sampler });

    await tracer.handleChainStart({}, {}, 'root', undefined, [], { env: 'prod' }, 'chain', 'Root');
    await tracer.handleToolStart({}, 'q', 'tool', 'root');

    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sampler).toHaveBeenCalledWith({
      traceId: 'root',
      type: 'chain',
      name: 'Root',
      metadata: { env: 'prod' },
    });
  });

  it('records the trace and reports it when the sampler throws', async () => {
    const { tracer, structure, failures } = setup({
      sampler: () => {
        throw new Error('sampler bug');
      },
    });

    await tracer.handleChainStart({}, {}, 'root');
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    expect(structure.trace('root')).toBeDefined();
    expect(failures).toEqual([expect.objectContaining({ kind: 'hook' })]);
  });

  it('propagates a sampled-out decision downstream, so parent-based services follow it', async () => {
    const upstream = setup({ sampler: () => false });
    const downstream = setup({ sampler: parentBasedSampler() });

    const request = upstream.tracer.startRun({ type: 'chain', name: 'request' });
    const call = upstream.tracer.startRun({
      type: 'tool',
      name: 'call',
      parentRunId: request.runId,
    });
    const header = call.traceparent();
    const handled = downstream.tracer.startRun({
      type: 'chain',
      name: 'handler',
      traceparent: header,
    });

    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(header?.split('-')[1]).toBe(request.traceparent()?.split('-')[1]);
    expect(handled.recorded).toBe(false);
  });

  it('keeps about the requested share of traces with a ratio sampler', async () => {
    const { tracer, structure } = setup({ sampler: ratioSampler(0.2) });

    for (let index = 0; index < 1000; index++) {
      const run = tracer.startRun({ type: 'chain', name: 'request' });
      await run.end();
    }
    await tracer.flush();

    // A trace may be written more than once (running, then finished); count distinct traces.
    const recorded = new Set(structure.traces.map((trace) => trace.traceId)).size;
    expect(recorded).toBeGreaterThan(150);
    expect(recorded).toBeLessThan(250);
    expect(tracer.stats().sampledOutTraces).toBe(1000 - recorded);
  });
});

describe('Tracer cancelled runs', () => {
  it('ends a run as cancelled, and lets an error take precedence', async () => {
    const { tracer, structure } = setup();

    tracer.startRun({ runId: 'root', type: 'chain', name: 'request' });
    const child = tracer.startRun({
      runId: 'child',
      type: 'agent',
      name: 'a',
      parentRunId: 'root',
    });
    await tracer.endRun(child.runId, { cancelled: true });
    await tracer.endRun('root', { cancelled: true });
    tracer.startRun({ runId: 'other', type: 'chain', name: 'request' });
    await tracer.endRun('other', { cancelled: true, error: new Error('boom') });
    await tracer.flush();

    expect(structure.run('child')).toMatchObject({ status: 'cancelled' });
    expect(structure.trace('root')).toMatchObject({ status: 'cancelled' });
    expect(structure.run('other')).toMatchObject({ status: 'error', error: { message: 'boom' } });
  });
});
