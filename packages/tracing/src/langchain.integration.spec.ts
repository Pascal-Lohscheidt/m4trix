import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { RunnableLambda } from '@langchain/core/runnables';
import { DynamicTool } from '@langchain/core/tools';
import {
  Annotation,
  END,
  MemorySaver,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  priceTable,
  type TraceRunNode,
  Tracer,
  TraceStore,
  TraceViewerApi,
} from './index.js';

/** A chat model that streams a fixed reply and reports usage the way provider integrations do. */
class ScriptedChatModel extends BaseChatModel {
  constructor(private readonly reply: string) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  invocationParams() {
    return { model: 'scripted-1' };
  }

  getLsParams() {
    return { ls_provider: 'scripted', ls_model_name: 'scripted-1', ls_model_type: 'chat' as const };
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    return {
      generations: [{ text: this.reply, message: this.message(messages) }],
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const words = this.reply.split(' ');
    for (const [index, word] of words.entries()) {
      const last = index === words.length - 1;
      const text = last ? word : `${word} `;
      await new Promise((resolve) => setTimeout(resolve, 2));
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: text,
          ...(last
            ? {
                usage_metadata: this.usage(messages),
                response_metadata: { model_name: 'scripted-1-0610' },
              }
            : {}),
        }),
      });
      await runManager?.handleLLMNewToken(text);
    }
  }

  private message(messages: BaseMessage[]): AIMessage {
    return new AIMessage({
      content: this.reply,
      usage_metadata: this.usage(messages),
      response_metadata: { model_name: 'scripted-1-0610' },
    });
  }

  private usage(messages: BaseMessage[]) {
    return {
      input_tokens: 100 * messages.length,
      output_tokens: this.reply.split(' ').length,
      total_tokens: 100 * messages.length + this.reply.split(' ').length,
      input_token_details: { cache_read: 50 },
    };
  }
}

describe('Tracer with LangChain and LangGraph', () => {
  let root: string;
  let traceStore: TraceStore;
  let api: TraceViewerApi;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-langchain-'));
    traceStore = TraceStore.of({
      structureStoreAdapter: new FsStructureStoreAdapter({ path: root }),
      payloadStoreAdapter: new FsPayloadStoreAdapter({ path: root }),
    });
    api = TraceViewerApi.from(traceStore);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('records a LangGraph run as one trace: nodes, streamed model call, tool, and events', async () => {
    const tracer = Tracer.from(traceStore, {
      cost: priceTable({ 'scripted-1': { input: 1, output: 2, cacheRead: 0.5 } }),
    });
    const model = new ScriptedChatModel('The weather is sunny');
    const weather = new DynamicTool({
      name: 'get_weather',
      description: 'Weather for a city',
      func: async (city: string) => `Sunny in ${city}`,
    });

    const graph = new StateGraph(MessagesAnnotation)
      .addNode('agent', async (state) => {
        await dispatchCustomEvent('plan', { step: 'call model' });
        const stream = await model.stream(state.messages);
        let reply: AIMessageChunk | undefined;
        for await (const chunk of stream) reply = reply ? reply.concat(chunk) : chunk;
        return { messages: reply ? [reply] : [] };
      })
      .addNode('tools', async () => ({
        messages: [new HumanMessage(await weather.invoke('Berlin'))],
      }))
      .addEdge(START, 'agent')
      .addEdge('agent', 'tools')
      .addEdge('tools', END)
      .compile({ checkpointer: new MemorySaver() });

    await graph.invoke(
      { messages: [new HumanMessage('Weather in Berlin?')] },
      {
        callbacks: [tracer],
        tags: ['integration'],
        metadata: { projectId: 'weather-app', userId: 'user-1' },
        configurable: { thread_id: 'thread-1' },
      },
    );
    await tracer.flush();

    const { traces } = await api.listTraces({ sessionId: 'thread-1' });
    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace).toMatchObject({
      projectId: 'weather-app',
      sessionId: 'thread-1',
      userId: 'user-1',
      status: 'success',
      tags: expect.arrayContaining(['integration']),
      tokens: { input: 100, output: 4, cached: 50 },
    });
    expect(trace.costUsd).toBeCloseTo((50 * 1 + 50 * 0.5 + 4 * 2) / 1_000_000);

    const tree = await api.getTraceTree(trace.traceId);
    const runs = flatten(tree?.root);
    const chat = runs.find((run) => run.type === 'chat_model');
    expect(chat).toMatchObject({
      name: 'ScriptedChatModel',
      provider: 'scripted',
      model: 'scripted-1-0610',
      status: 'success',
      tokens: { input: 100, output: 4, cached: 50 },
      timeToFirstTokenMs: expect.any(Number),
    });
    expect(chat?.timeToFirstTokenMs).toBeLessThanOrEqual(chat?.latencyMs ?? 0);
    expect(runs.find((run) => run.type === 'tool')).toMatchObject({
      name: 'get_weather',
      status: 'success',
    });

    const agentNode = runs.find((run) => run.name === 'agent');
    expect(agentNode?.children.map((child) => child.runId)).toContain(chat?.runId);
    expect(await api.getPayload(agentNode?.eventsRef ?? '')).toEqual([
      { name: 'plan', time: expect.any(String), data: { step: 'call model' } },
    ]);

    const example = await api.getTraceExample(trace.traceId);
    expect(example).toMatchObject({
      input: {
        messages: [
          expect.objectContaining({
            kwargs: expect.objectContaining({ content: 'Weather in Berlin?' }),
          }),
        ],
      },
      output: { messages: expect.any(Array) },
      status: 'success',
    });
    expect(tracer.activeTraceCount).toBe(0);
  });

  it('marks failed nodes and the trace as errors with details', async () => {
    const tracer = Tracer.from(traceStore);
    const graph = new StateGraph(Annotation.Root({ value: Annotation<number> }))
      .addNode('explode', async () => {
        throw Object.assign(new Error('upstream 503'), { status: 503 });
      })
      .addEdge(START, 'explode')
      .compile();

    await expect(graph.invoke({ value: 1 }, { callbacks: [tracer] })).rejects.toThrow(
      'upstream 503',
    );
    await tracer.flush();

    const { traces } = await api.listTraces({ status: 'error' });
    expect(traces).toHaveLength(1);
    const record = await api.getTrace(traces[0].traceId);
    expect(record?.runs.find((run) => run.name === 'explode')).toMatchObject({
      status: 'error',
      error: {
        message: 'upstream 503',
        status: 503,
        stack: expect.stringContaining('upstream 503'),
      },
    });
  });

  it('nests a LangChain call under a span of the surrounding code with childOf', async () => {
    const tracer = Tracer.from(traceStore);
    const chain = RunnableLambda.from(async (question: string) => {
      const reply = await new ScriptedChatModel('Paris').invoke([new HumanMessage(question)]);
      return reply.content;
    }).withConfig({ runName: 'answer' });

    const request = tracer.startRun({
      type: 'chain',
      name: 'http POST /ask',
      input: { q: 'capital?' },
    });
    const answer = await chain.invoke('capital of France?', {
      callbacks: [tracer.childOf(request.runId)],
    });
    await request.end({ output: { answer } });
    await tracer.flush();

    const tree = await api.getTraceTree(request.runId);
    expect(tree?.root).toMatchObject({
      name: 'http POST /ask',
      children: [
        expect.objectContaining({
          name: 'answer',
          children: [
            expect.objectContaining({
              type: 'chat_model',
              tokens: expect.objectContaining({ input: 100 }),
            }),
          ],
        }),
      ],
    });
  });

  it('keeps the traced app running when the store is broken', async () => {
    const failures: unknown[] = [];
    const broken = TraceStore.of({
      structureStoreAdapter: new FsStructureStoreAdapter({ path: join(root, 'missing', '\0bad') }),
      payloadStoreAdapter: new FsPayloadStoreAdapter({ path: join(root, 'missing', '\0bad') }),
    });
    const tracer = Tracer.from(broken, { onError: (failure) => failures.push(failure) });
    const chain = RunnableLambda.from(async (n: number) => n * 2);

    await expect(chain.invoke(21, { callbacks: [tracer] })).resolves.toBe(42);
    await expect(tracer.flush()).resolves.toBeUndefined();
    expect(failures.length).toBeGreaterThan(0);
  });
});

function flatten(node: TraceRunNode | undefined): TraceRunNode[] {
  return node ? [node, ...node.children.flatMap(flatten)] : [];
}
