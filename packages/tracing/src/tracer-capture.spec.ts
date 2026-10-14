import { AIMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { priceTable, Tracer, type TracerFailure, type TracerOptions } from './index.js';
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

const chatResult = (input: number, output: number, cached?: number) => ({
  generations: [
    [
      {
        text: 'hi',
        message: new AIMessage({
          content: 'hi',
          usage_metadata: {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
            ...(cached !== undefined ? { input_token_details: { cache_read: cached } } : {}),
          },
          response_metadata: { model_name: 'gpt-4o-2024-08-06' },
        }),
      },
    ],
  ],
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Tracer model calls', () => {
  it('records the requested model and provider, then the model that actually served', async () => {
    const { tracer, structure } = setup();

    await tracer.handleChatModelStart(
      { id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] },
      [[]],
      'llm',
      undefined,
      { invocation_params: { model: 'gpt-4o' } },
      undefined,
      { ls_provider: 'openai', ls_model_name: 'gpt-4o' },
    );
    await tracer.flush();
    expect(structure.run('llm')).toMatchObject({
      name: 'ChatOpenAI',
      model: 'gpt-4o',
      provider: 'openai',
    });

    await tracer.handleLLMEnd(chatResult(10, 5), 'llm');
    await tracer.flush();
    expect(structure.run('llm')).toMatchObject({
      model: 'gpt-4o-2024-08-06',
      provider: 'openai',
      tokens: { input: 10, output: 5 },
    });
  });

  it('prices calls with the cost calculator and adds cost and usage up per trace', async () => {
    const { tracer, structure } = setup({
      cost: priceTable({ 'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 } }),
    });

    await tracer.handleChainStart({}, {}, 'root');
    await tracer.handleChatModelStart({}, [[]], 'llm-1', 'root');
    await tracer.handleLLMEnd(chatResult(1_000_000, 100_000, 800_000), 'llm-1');
    await tracer.handleChatModelStart({}, [[]], 'llm-2', 'root');
    await tracer.handleLLMEnd(chatResult(1_000_000, 0), 'llm-2');
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    expect(structure.run('llm-1')?.costUsd).toBeCloseTo(0.5 + 1 + 1);
    expect(structure.run('llm-2')?.costUsd).toBeCloseTo(2.5);
    expect(structure.trace('root')).toMatchObject({
      tokens: { input: 2_000_000, output: 100_000, cached: 800_000 },
    });
    expect(structure.trace('root')?.costUsd).toBeCloseTo(5);
  });

  it('leaves cost out when the calculator cannot price the model, or throws', async () => {
    const { tracer, structure, failures } = setup({
      cost: ({ model }) => {
        if (model === 'gpt-4o-2024-08-06') throw new Error('pricing bug');
        return undefined;
      },
    });

    await tracer.handleChatModelStart({}, [[]], 'llm');
    await tracer.handleLLMEnd(chatResult(1, 1), 'llm');
    await tracer.flush();

    expect(structure.run('llm')).not.toHaveProperty('costUsd');
    expect(failures).toEqual([expect.objectContaining({ kind: 'hook', runId: 'llm' })]);
  });

  it('measures time to first token from streamed tokens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { tracer, structure } = setup();

    await tracer.handleChatModelStart({}, [[]], 'llm');
    vi.advanceTimersByTime(250);
    await tracer.handleLLMNewToken('Hel', { prompt: 0, completion: 0 }, 'llm');
    vi.advanceTimersByTime(500);
    await tracer.handleLLMNewToken('lo', { prompt: 0, completion: 0 }, 'llm');
    await tracer.handleLLMEnd(chatResult(1, 2), 'llm');
    await tracer.flush();

    expect(structure.run('llm')).toMatchObject({ timeToFirstTokenMs: 250, latencyMs: 750 });
  });
});

describe('Tracer events', () => {
  it('stores custom events, agent actions, and text on the run they belong to', async () => {
    const { tracer, structure, payloads } = setup();

    await tracer.handleChainStart({}, {}, 'root');
    await tracer.handleCustomEvent('progress', { step: 1 }, 'root');
    await tracer.handleAgentAction({ tool: 'search', toolInput: 'q', log: '' }, 'root');
    await tracer.handleText('thinking', 'root');
    await tracer.handleAgentEnd({ returnValues: { output: 'done' }, log: '' }, 'root');
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    const run = structure.run('root');
    expect(run?.eventsRef).toBe('traces/root/payloads/root/events.json');
    expect(payloads.payloads.get(run?.eventsRef ?? '')).toEqual([
      { name: 'progress', time: expect.any(String), data: { step: 1 } },
      {
        name: 'agent_action',
        time: expect.any(String),
        data: { tool: 'search', toolInput: 'q', log: '' },
      },
      { name: 'text', time: expect.any(String), data: { text: 'thinking' } },
      {
        name: 'agent_end',
        time: expect.any(String),
        data: { returnValues: { output: 'done' }, log: '' },
      },
    ]);
  });

  it('caps events per run and counts the rest', async () => {
    const { tracer, payloads } = setup({ maxEventsPerRun: 2 });

    const run = tracer.startRun({ type: 'chain', name: 'busy' });
    for (let index = 0; index < 5; index++) run.addEvent('tick', index);
    await run.end();
    await tracer.flush();

    expect(
      payloads.payloads.get(`traces/${run.runId}/payloads/${run.runId}/events.json`),
    ).toHaveLength(2);
    expect(tracer.stats().droppedEvents).toBe(3);
  });

  it('ignores events after a run has ended', async () => {
    const { tracer, structure } = setup();

    const run = tracer.startRun({ type: 'chain', name: 'done' });
    await run.end();
    run.addEvent('late');
    await tracer.flush();

    expect(structure.run(run.runId)).not.toHaveProperty('eventsRef');
  });
});

describe('Tracer trace attributes', () => {
  it('lifts project, session, and user out of root metadata and keeps tags first-class', async () => {
    const { tracer, structure } = setup();

    await tracer.handleChainStart({}, {}, 'root', undefined, ['prod', 'checkout'], {
      projectId: 'shop',
      sessionId: 'session-1',
      userId: 'user-1',
      env: 'prod',
      nested: { no: 1 },
    });
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    expect(structure.trace('root')).toMatchObject({
      projectId: 'shop',
      sessionId: 'session-1',
      userId: 'user-1',
      tags: ['prod', 'checkout'],
      metadata: { env: 'prod' },
    });
    expect(structure.run('root')).toMatchObject({
      tags: ['prod', 'checkout'],
      metadata: { env: 'prod' },
    });
    expect(structure.run('root')?.extra).not.toHaveProperty('tags');
  });

  it("uses LangGraph's thread_id as the session", async () => {
    const { tracer, structure } = setup();

    await tracer.handleChainStart({}, {}, 'root', undefined, [], { thread_id: 'thread-7' });
    await tracer.handleChainEnd({}, 'root');
    await tracer.flush();

    expect(structure.trace('root')).toMatchObject({
      sessionId: 'thread-7',
      metadata: { thread_id: 'thread-7' },
    });
  });

  it('continues an upstream trace from traceparent and propagates it downstream', async () => {
    const { tracer, structure } = setup();
    const upstream = '4bf92f3577b34da6a3ce929d0e0e4736';

    const root = tracer.startRun({
      type: 'chain',
      name: 'handler',
      traceparent: `00-${upstream}-00f067aa0ba902b7-01`,
    });
    const child = tracer.startRun({ type: 'tool', name: 'call-api', parentRunId: root.runId });
    const downstream = child.traceparent();
    await child.end();
    await root.end();
    await tracer.flush();

    expect(structure.trace(root.runId)?.remoteParent).toEqual({
      traceId: upstream,
      spanId: '00f067aa0ba902b7',
      sampled: true,
    });
    expect(downstream).toMatch(new RegExp(`^00-${upstream}-[0-9a-f]{16}-01$`));
    expect(tracer.traceparent('unknown')).toBeUndefined();
  });

  it('records error details', async () => {
    const { tracer, structure } = setup();
    const error = Object.assign(new Error('overloaded'), { status: 529, name: 'APIError' });

    await tracer.handleChatModelStart({}, [[]], 'llm');
    await tracer.handleLLMError(error, 'llm');
    await tracer.flush();

    expect(structure.run('llm')).toMatchObject({
      status: 'error',
      error: { message: 'overloaded', type: 'APIError', status: 529, stack: expect.any(String) },
    });
  });
});

describe('Tracer run API', () => {
  it('traces any code with startRun handles', async () => {
    const { tracer, structure, payloads } = setup();

    const request = tracer.startRun({
      type: 'chain',
      name: 'request',
      input: { q: 'hi' },
      sessionId: 's',
    });
    const lookup = tracer.startRun({
      type: 'tool',
      name: 'lookup',
      parentRunId: request.runId,
      input: 'hi',
    });
    await lookup.end({ error: new Error('not found') });
    await request.end({ output: { a: 'sorry' }, tokens: { input: 1, output: 2 }, costUsd: 0.5 });
    await tracer.flush();

    expect(request.recorded).toBe(true);
    expect(structure.trace(request.runId)).toMatchObject({
      name: 'request',
      sessionId: 's',
      status: 'error',
      runCount: 2,
      tokens: { input: 1, output: 2 },
      costUsd: 0.5,
    });
    expect(structure.run(lookup.runId)).toMatchObject({
      parentRunId: request.runId,
      traceId: request.runId,
      status: 'error',
      error: { message: 'not found' },
    });
    expect(payloads.payloads.get(structure.run(request.runId)?.outputRef ?? '')).toEqual({
      a: 'sorry',
    });
  });

  it('ends a run once, whatever is called after', async () => {
    const { tracer, structure } = setup();

    const run = tracer.startRun({ type: 'chain', name: 'once' });
    await run.end({ output: 'first' });
    await run.end({ error: new Error('second') });
    await tracer.endRun(run.runId);
    await tracer.flush();

    expect(structure.run(run.runId)).toMatchObject({ status: 'success' });
  });

  it('hands out inert handles for sampled-out traces', async () => {
    const { tracer, structure } = setup({ sampler: () => false });

    const run = tracer.startRun({ type: 'chain', name: 'skipped' });
    run.addEvent('event');
    await run.end({ output: 'x' });
    await tracer.flush();

    expect(run.recorded).toBe(false);
    expect(run.traceparent()).toBeUndefined();
    expect(structure.batches).toEqual([]);
  });

  it('nests top-level LangChain runs under a parent with childOf', async () => {
    const { tracer, structure } = setup();

    const agent = tracer.startRun({ type: 'agent', name: 'planner' });
    const child = tracer.childOf(agent.runId);
    await child.handleChainStart({}, {}, 'graph-root');
    await child.handleToolStart({}, 'q', 'graph-tool', 'graph-root');
    await child.handleToolEnd({}, 'graph-tool');
    await child.handleChainEnd({}, 'graph-root');
    await agent.end();
    await tracer.flush();

    expect(structure.run('graph-root')).toMatchObject({
      parentRunId: agent.runId,
      traceId: agent.runId,
    });
    expect(structure.run('graph-tool')).toMatchObject({
      parentRunId: 'graph-root',
      traceId: agent.runId,
    });
    expect(structure.trace(agent.runId)).toMatchObject({ runCount: 3 });
    expect(tracer.stats()).toEqual(child.stats());
  });
});
