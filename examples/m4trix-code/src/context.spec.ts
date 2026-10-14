// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelName, type EnvelopeLike, type StoredEvent } from '@m4trix/core';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type ConversationState,
  completesStep,
  Conversation,
  createChatView,
  needsCompaction,
  StepProgress,
  splitForCompaction,
  toChatMessages,
} from './context.js';
import { AssistantMessage, ContextCompacted, ModelStep, ToolResult, UserPrompt } from './events.js';
import {
  type ChatMessage,
  createWorkspace,
  Model,
  type ModelApi,
  type ModelResponse,
} from './layers.js';
import { createCoderNetwork } from './network.js';

/* ─── Helpers ─── */

const at = (runId: string) => ({ runId, contextId: 'ctx-1' });

const call = (id: string, path: string) => ({
  id,
  name: 'read_file',
  arguments: JSON.stringify({ path }),
});

const result = (stepId: string, callId: string, output: string) =>
  ToolResult.makeBound(at('run-1'), { stepId, callId, name: 'read_file', ok: true, output });

/** Turn 1 reads two files (results out of order) and answers; turn 2 has one step, no result yet. */
const recorded: EnvelopeLike[] = [
  UserPrompt.makeBound(at('run-1'), { text: 'What do a.ts and b.ts export?' }),
  ModelStep.makeBound(at('run-1'), {
    stepId: 'step-1',
    text: 'Reading both.',
    toolCalls: [call('call-a', 'a.ts'), call('call-b', 'b.ts')],
  }),
  result('step-1', 'call-b', `// b.ts\n${'export const b = 1;\n'.repeat(80)}`),
  result('step-1', 'call-a', `// a.ts\n${'export const a = 1;\n'.repeat(80)}`),
  AssistantMessage.makeBound(at('run-1'), { text: 'Both export one constant.' }),
  UserPrompt.makeBound(at('run-2'), { text: 'Now read c.ts.' }),
  ModelStep.makeBound(at('run-2'), {
    stepId: 'step-2',
    text: '',
    toolCalls: [call('call-c', 'c.ts')],
  }),
];

const fold = (events: readonly EnvelopeLike[]) =>
  Conversation.applyAll(Conversation.initialState(), events);

const ids = (state: ConversationState) => state.segments.map((segment) => segment.id);

/** The chat API's rule: every tool call is answered right after the message that made it. */
function expectEveryToolCallAnswered(messages: ChatMessage[]) {
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !message.tool_calls) return;
    const answers = messages.slice(index + 1, index + 1 + message.tool_calls.length);
    expect(answers.map((answer) => (answer.role === 'tool' ? answer.tool_call_id : null))).toEqual(
      message.tool_calls.map((toolCall) => toolCall.id),
    );
  });
}

/* ─── The fold and its rendering ─── */

describe('Conversation fold', () => {
  test('a model step and all of its tool results are one segment', () => {
    const state = fold(recorded);

    expect(ids(state)).toEqual([
      'prompt:run-1',
      'step-1',
      'answer:run-1',
      'prompt:run-2',
      'step-2',
    ]);
    const step = state.segments[1]?.data;
    expect(step?.kind === 'step' && step.results.map((r) => r.callId)).toEqual([
      'call-b',
      'call-a',
    ]);
  });

  test('renders every tool call answered right after its step, in call order', () => {
    const messages = toChatMessages(fold(recorded));

    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
      'user',
      'assistant',
      'tool',
    ]);
    expectEveryToolCallAnswered(messages);
    expect(messages[2]).toMatchObject({
      tool_call_id: 'call-a',
      content: expect.stringContaining('// a.ts'),
    });
    // An empty step text is sent as null, like the API returns it.
    expect(messages[6]).toMatchObject({ role: 'assistant', content: null });
  });

  test('a step without its results (an interrupted turn) gets a placeholder result per call', () => {
    const messages = toChatMessages(fold(recorded));

    expect(messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call-c',
      content: 'No result: the turn was interrupted.',
    });
  });

  test('a checkpoint replaces the state; its summary is rendered first', () => {
    const compacted = ContextCompacted.makeBound(at('run-2'), {
      summary: 'The user asked about a.ts and b.ts; both export one constant.',
      kept: fold(recorded).segments.slice(-2),
      summarized: 3,
    });
    const after = [
      compacted,
      // A late result of a summarized step is ignored; one of a kept step is attached.
      result('step-1', 'call-a', 'late'),
      result('step-2', 'call-c', '// c.ts'),
    ];

    const warm = Conversation.applyAll(fold(recorded), after);
    const cold = fold(after);
    expect(warm).toEqual(cold);
    expect(ids(warm)).toEqual(['prompt:run-2', 'step-2']);

    const messages = toChatMessages(warm);
    expect(messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('The user asked about a.ts and b.ts'),
    });
    expect(messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages.at(-1)).toMatchObject({ tool_call_id: 'call-c', content: '// c.ts' });
  });
});

describe('chat view', () => {
  test('a generous budget keeps everything as it is', () => {
    const state = fold(recorded);
    const chat = createChatView(100_000).select(state);

    expect(chat).toMatchObject({ overBudget: false, dropped: [] });
    expect(chat.state).toBe(state);
    expect(needsCompaction(chat, 4)).toBe(false);
  });

  test('tight budgets elide old tool outputs, then drop old turns, never splitting a step', () => {
    const state = fold(recorded);
    const full = createChatView(100_000).select(state).tokens;

    const elided = createChatView(full - 1).select(state);
    expect(elided.dropped).toEqual([]);
    const step = elided.state.segments[1]?.data;
    expect(step?.kind === 'step' && step.results.every((r) => r.output.includes('[elided'))).toBe(
      true,
    );

    for (const budget of [1, 20, 60, 120, 400]) {
      const chat = createChatView(budget).select(state);
      expectEveryToolCallAnswered(toChatMessages(chat.state));
      // The current turn is pinned.
      expect(ids(chat.state).slice(-2)).toEqual(['prompt:run-2', 'step-2']);
    }
  });

  test('compaction is needed when the view drops or overflows, and only if it can make progress', () => {
    const state = fold(recorded);

    const dropping = createChatView(60).select(state);
    expect(dropping.dropped.length).toBeGreaterThan(0);
    expect(needsCompaction(dropping, 4)).toBe(true);

    const overflowing = createChatView(1).select(state);
    expect(overflowing.overBudget).toBe(true);
    expect(needsCompaction(overflowing, 4)).toBe(true);
    // Nothing beyond the segments the compactor keeps: compacting again would not help.
    expect(needsCompaction(overflowing, 5)).toBe(false);
  });

  test('splitForCompaction keeps the newest segments verbatim', () => {
    const { older, kept } = splitForCompaction(fold(recorded), 2);

    expect(older.map((s) => s.id)).toEqual(['prompt:run-1', 'step-1', 'answer:run-1']);
    expect(kept.map((s) => s.id)).toEqual(['prompt:run-2', 'step-2']);
  });
});

describe('StepProgress fold', () => {
  const progress = (events: readonly EnvelopeLike[]) =>
    StepProgress.applyAll(StepProgress.initialState(), events);

  test('counts steps and completes a step exactly once: on the result that fills it', () => {
    const [, step1, resultB, resultA] = recorded as [
      EnvelopeLike,
      EnvelopeLike,
      EnvelopeLike,
      EnvelopeLike,
    ];

    const partial = progress([step1, resultB]);
    expect(partial.steps).toBe(1);
    expect(completesStep(partial, 'step-1', 'call-b')).toBe(false);

    // Both results folded (the reader of the first one may run late): only the last completes it.
    const full = progress([step1, resultB, resultA]);
    expect(completesStep(full, 'step-1', 'call-b')).toBe(false);
    expect(completesStep(full, 'step-1', 'call-a')).toBe(true);
    expect(completesStep(full, 'step-unknown', 'call-a')).toBe(false);
  });
});

/* ─── The network, with a fake model ─── */

type Request = Parameters<ModelApi['complete']>[0];

/** A scripted Model layer: records every request, answers with `script`. */
function fakeModel(script: (request: Request, index: number) => ModelResponse) {
  const requests: Array<{ messages: ChatMessage[]; tools: number }> = [];
  const layer = Model.make({
    config: { model: 'fake' },
    model: 'fake',
    async complete(request) {
      requests.push({ messages: structuredClone(request.messages), tools: request.tools.length });
      const response = script(request, requests.length - 1);
      if (response.text) request.onText(response.text);
      return response;
    },
  });
  return { layer, requests };
}

describe('coder network', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-code-'));
    await writeFile(join(root, 'a.txt'), 'alpha\n');
    await writeFile(join(root, 'b.txt'), 'beta\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test('the wiring check reports no errors and no warnings', () => {
    const network = createCoderNetwork({ instructions: '', maxSteps: 10, contextBudget: 1000 });
    expect(network.validate()).toEqual({ errors: [], warnings: [] });
  });

  test('a turn with a tool step compacts when over budget and still answers every call', async () => {
    const model = fakeModel((request) => {
      if (request.tools.length === 0) {
        return { text: 'SUMMARY: the user asked what a.txt and b.txt contain.', toolCalls: [] };
      }
      const last = request.messages.at(-1);
      if (last?.role === 'user') {
        return {
          text: 'Reading both.',
          toolCalls: [call('call-a', 'a.txt'), call('call-b', 'b.txt')],
        };
      }
      return { text: 'a.txt says alpha, b.txt says beta.', toolCalls: [] };
    });
    const network = createCoderNetwork({
      instructions: '',
      maxSteps: 5,
      contextBudget: 10, // tiny: the second model call is over budget
      keepSegments: 1,
    });
    const meta = { runId: 'run-1', contextId: 'ctx-1' };

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run({
          layers: { Model: model.layer, Workspace: createWorkspace(root) },
        });
        yield* plane.publish(ChannelName('main'), {
          name: UserPrompt.name,
          meta,
          payload: { text: 'What do a.txt and b.txt contain?' },
        });
        yield* plane.awaitRunEnd(meta.runId);
        return yield* Effect.promise(() => plane.history(meta).run());
      }).pipe(Effect.scoped),
    );

    const names = events.map((event: StoredEvent) => event.name);
    expect(names.filter((name) => name === 'step-completed')).toHaveLength(1);
    expect(names).toContain('compaction-requested');
    const compacted = events.find(ContextCompacted.is);
    expect(compacted?.payload).toMatchObject({ summarized: 1, kept: [{ data: { kind: 'step' } }] });
    expect(events.find(AssistantMessage.is)?.payload.text).toBe(
      'a.txt says alpha, b.txt says beta.',
    );

    // Three model calls: the step, the summary (no tools), the answer from the checkpoint.
    expect(model.requests.map((r) => r.tools > 0)).toEqual([true, false, true]);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(
      'What do a.txt and b.txt contain?',
    );
    const final = model.requests[2]?.messages ?? [];
    expect(final.map((m) => m.role)).toEqual(['system', 'system', 'assistant', 'tool', 'tool']);
    expect(final[1]?.content).toContain('SUMMARY: the user asked');
    expectEveryToolCallAnswered(final);
    expect(final.slice(3).map((m) => m.content)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);

    // A cold rebuild of the conversation starts at the checkpoint.
    const rebuilt = fold(events);
    expect(rebuilt.checkpoint).toContain('SUMMARY');
    expect(rebuilt.segments.map((s) => s.data.kind)).toEqual(['step', 'answer']);
  });
});
