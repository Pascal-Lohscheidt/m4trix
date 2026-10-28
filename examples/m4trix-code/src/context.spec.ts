// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentNetworkStore,
  ChannelName,
  ContextStrategy,
  type EnvelopeLike,
  type EventPlane,
  type FoldCheckpointEnvelope,
  isFoldCheckpointEvent,
  type StoredEvent,
} from '@m4trix/core';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ChatView,
  type ConversationSegment,
  type ConversationState,
  compactionChunks,
  compactionMessages,
  completesStep,
  Conversation,
  defaultKeepTokens,
  StepProgress,
  toChatMessages,
} from './context.js';
import { AssistantMessage, ModelStep, ToolResult, UserPrompt } from './events.js';
import {
  type ChatMessage,
  createWorkspace,
  Model,
  type ModelApi,
  type ModelResponse,
} from './layers.js';
import { createCoderNetwork } from './network.js';
import { openSession } from './session.js';

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

  test('a compacted state renders its summary first; later events fold on top of it', () => {
    // What a compaction leaves: a summary of the older segments, and the newest ones kept.
    const compacted: ConversationState = {
      summary: 'The user asked about a.ts and b.ts; both export one constant.',
      segments: fold(recorded).segments.slice(-2),
    };
    const after = [
      // A late result of a summarized step is ignored; one of a kept step is attached.
      result('step-1', 'call-a', 'late'),
      result('step-2', 'call-c', '// c.ts'),
    ];

    const state = Conversation.applyAll(compacted, after);
    expect(ids(state)).toEqual(['prompt:run-2', 'step-2']);

    const messages = toChatMessages(state);
    expect(messages[0]).toEqual({
      role: 'system',
      content: expect.stringContaining('The user asked about a.ts and b.ts'),
    });
    expect(messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages.at(-1)).toMatchObject({ tool_call_id: 'call-c', content: '// c.ts' });
  });
});

describe('chat view', () => {
  const chatAt = (state: ConversationState, budget: number) => ChatView(state, { budget });

  test('one view, any budget: a generous one keeps everything as it is', () => {
    const state = fold(recorded);
    const chat = chatAt(state, 100_000);

    expect(chat).toMatchObject({ overBudget: false, dropped: [], fits: true });
    expect(chat.state).toBe(state);
  });

  test('tight budgets elide old tool outputs, then drop old turns, never splitting a step', () => {
    const state = fold(recorded);
    const full = chatAt(state, 100_000).tokens;

    const elided = chatAt(state, full - 1);
    expect(elided).toMatchObject({ dropped: [], fits: true });
    const step = elided.state.segments[1]?.data;
    expect(step?.kind === 'step' && step.results.every((r) => r.output.includes('[elided'))).toBe(
      true,
    );
    // Elision alone keeps the whole conversation: it fits, so the model agent does not compact.

    for (const budget of [1, 20, 60, 120, 400]) {
      const chat = chatAt(state, budget);
      expectEveryToolCallAnswered(toChatMessages(chat.state));
      // The current turn is kept: from the newest user prompt on.
      expect(ids(chat.state).slice(-2)).toEqual(['prompt:run-2', 'step-2']);
    }
  });

  test('the view does not fit once it has to drop segments, or the current turn is over budget', () => {
    const state = fold(recorded);

    const dropping = chatAt(state, 60);
    expect(dropping).toMatchObject({ overBudget: false, fits: false });
    expect(dropping.dropped.length).toBeGreaterThan(0);
    expect(chatAt(state, 1)).toMatchObject({ overBudget: true, fits: false });
  });

  test('a compaction keeps the newest segments that fit keepTokens, at least the newest', () => {
    const state = fold(recorded);
    const tokens = (wanted: string[]) =>
      state.segments
        .filter((segment) => wanted.includes(segment.id))
        .reduce((sum, segment) => sum + ChatView.count(segment), 0);

    const split = (keepTokens: number) =>
      ChatView.split(state, { keepTokens, keepFrom: ContextStrategy.newest() });

    const last2 = split(tokens(['prompt:run-2', 'step-2']));
    expect(last2.older.map((s) => s.id)).toEqual(['prompt:run-1', 'step-1', 'answer:run-1']);
    expect(last2.kept.map((s) => s.id)).toEqual(['prompt:run-2', 'step-2']);

    // Nothing fits zero tokens: the newest segment is kept anyway.
    expect(split(0).kept.map((s) => s.id)).toEqual(['step-2']);
    // With only the newest segment left, nothing is older: compacting again would not help.
    const newestOnly: ConversationState = {
      summary: 'summary',
      segments: state.segments.slice(-1),
    };
    expect(
      ChatView.split(newestOnly, { keepTokens: 0, keepFrom: ContextStrategy.newest() }),
    ).toEqual({
      older: [],
      kept: newestOnly.segments,
    });
  });

  test('a compaction asks the summary to restate the newest request, verbatim', () => {
    // The current prompt may be summarized away (a long turn compacts its own prompt too): the
    // model then knows the request only through the summary.
    const older = fold(recorded).segments.slice(0, -1);
    const [system, transcript] = compactionMessages('Earlier: hello.', older);

    expect(system?.content).toContain(
      'End with the newest user request in this transcript, quoted verbatim.',
    );
    expect(transcript?.content).toContain('[Earlier summary]\nEarlier: hello.');
    expect(transcript?.content).toContain('[User]\nNow read c.ts.');
    // Long tool outputs are cut; a call without a result says so.
    expect(transcript?.content).toContain('… [108 more characters]');
    const [, withPending] = compactionMessages(undefined, fold(recorded).segments);
    expect(withPending?.content).toMatch(
      /\[Tool read_file\(\{"path":"c\.ts"\}\)\]\nNo result: the turn was interrupted\.$/,
    );
  });

  test('compaction chunks: consecutive runs of segments whose transcript fits the tokens, at least one each', () => {
    const older = fold(recorded).segments.slice(0, -1); // prompt, step (two big results), answer, prompt
    const tokens = (chunk: readonly ConversationSegment[]) =>
      Math.ceil(String(compactionMessages(undefined, chunk)[1]?.content).length / 4);
    const ids = (chunks: ReadonlyArray<readonly ConversationSegment[]>) =>
      chunks.map((chunk) => chunk.map((segment) => segment.id));

    // Everything fits: one request, as without chunks.
    expect(ids(compactionChunks(older, 100_000))).toEqual([
      ['prompt:run-1', 'step-1', 'answer:run-1', 'prompt:run-2'],
    ]);
    // The step alone is over 100 tokens: a chunk of its own; the others fit next to each other.
    const chunks = compactionChunks(older, 100);
    expect(ids(chunks)).toEqual([['prompt:run-1'], ['step-1'], ['answer:run-1', 'prompt:run-2']]);
    expect(tokens(chunks[1] ?? [])).toBeGreaterThan(100);
    for (const chunk of [chunks[0], chunks[2]]) {
      expect(tokens(chunk ?? [])).toBeLessThanOrEqual(100);
    }
    // Nothing to summarize: one empty chunk.
    expect(compactionChunks([], 100)).toEqual([[]]);
  });

  test('a compaction keeps half the budget by default', () => {
    expect(defaultKeepTokens(100_000)).toBe(50_000);
    expect(defaultKeepTokens(11)).toBe(5.5);
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

  /** Runs one turn on `plane` and resolves with the run's stored events. */
  const turn = (plane: EventPlane, runId: string, text: string, contextId = 'ctx-1') =>
    Effect.gen(function* () {
      const meta = { runId, contextId };
      yield* plane.publish(ChannelName('main'), { name: UserPrompt.name, meta, payload: { text } });
      yield* plane.awaitRunEnd(runId);
      return yield* Effect.promise(() => plane.history(meta).run());
    });

  const checkpoints = (events: readonly StoredEvent[]) =>
    events.filter((event): event is FoldCheckpointEnvelope & StoredEvent =>
      isFoldCheckpointEvent(event),
    );

  /** Reads both files in one step, then answers; a request without tools is a summary. */
  const readBothFiles = (request: Request): ModelResponse => {
    if (request.tools.length === 0) {
      // Deterministic: the same transcript always gets the same summary.
      const transcript = String(request.messages.at(-1)?.content ?? '');
      return { text: `SUMMARY of ${transcript.length} characters`, toolCalls: [] };
    }
    const last = request.messages.at(-1);
    if (last?.role === 'user') {
      return {
        text: 'Reading both.',
        toolCalls: [call('call-a', 'a.txt'), call('call-b', 'b.txt')],
      };
    }
    return { text: 'a.txt says alpha, b.txt says beta.', toolCalls: [] };
  };

  test('a turn with a tool step compacts once when over budget and still answers every call', async () => {
    const model = fakeModel(readBothFiles);
    const network = createCoderNetwork({
      instructions: '',
      maxSteps: 5,
      contextBudget: 10, // tiny: every model call is over budget; a compaction keeps 5 tokens
    });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run({
          layers: { Model: model.layer, Workspace: createWorkspace(root) },
        });
        return yield* turn(plane, 'run-1', 'What do a.txt and b.txt contain?');
      }).pipe(Effect.scoped),
    );

    const names = events.map((event: StoredEvent) => event.name);
    expect(names.filter((name) => name === 'step-completed')).toHaveLength(1);
    // One compaction: before the first call there is nothing older to summarize, and after it
    // only the newest step (over budget on its own) is left, so it is not repeated.
    const [checkpoint, ...more] = checkpoints(events);
    expect(more).toEqual([]);
    expect(checkpoint).toMatchObject({
      name: 'm4trix:fold.checkpoint:conversation@1',
      payload: {
        fold: 'conversation',
        version: 1,
        through: expect.any(String),
        state: {
          summary: expect.stringContaining('SUMMARY'),
          segments: [{ data: { kind: 'step' } }],
        },
      },
    });
    // The checkpoint is stored, never streamed: it went to no channel.
    expect(checkpoint?.channels).toEqual([]);
    expect(names).not.toContain('compaction-requested');
    expect(events.find(AssistantMessage.is)?.payload.text).toBe(
      'a.txt says alpha, b.txt says beta.',
    );

    // Three model calls: the step, the summary (no tools), the answer from the compacted state.
    expect(model.requests.map((r) => r.tools > 0)).toEqual([true, false, true]);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(
      'What do a.txt and b.txt contain?',
    );
    const final = model.requests[2]?.messages ?? [];
    expect(final.map((m) => m.role)).toEqual(['system', 'system', 'assistant', 'tool', 'tool']);
    expect(final[1]?.content).toContain('SUMMARY of');
    expectEveryToolCallAnswered(final);
    expect(final.slice(3).map((m) => m.content)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);
  });

  test('a restarted process (a new network over a new file store on the session) sends the model the same context', async () => {
    const reported: string[] = [];
    const logger = {
      warn: (message: string) => reported.push(`warn: ${message}`),
      error: (message: string) => reported.push(`error: ${message}`),
    };
    const options = { instructions: '', maxSteps: 5, contextBudget: 10, logger };
    const layers = (model: ReturnType<typeof fakeModel>) => ({
      Model: model.layer,
      Workspace: createWorkspace(root),
    });
    const second = (requests: ReturnType<typeof fakeModel>['requests'], from: number) =>
      requests.slice(from).map((request) => request.messages);

    // Warm: both turns on one plane (in memory), so the second turn continues the cached
    // conversation.
    const warm = fakeModel(readBothFiles);
    const warmNetwork = createCoderNetwork(options);
    const warmFrom = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* warmNetwork.run({ layers: layers(warm) });
        yield* turn(plane, 'run-1', 'What do a.txt and b.txt contain?');
        const before = warm.requests.length;
        yield* turn(plane, 'run-2', 'And which one is longer?');
        return before;
      }).pipe(Effect.scoped),
    );

    // Cold: each turn in a process of its own over the session directory (`--session`). The
    // first turn compacts; the second process shares nothing with the first but the files.
    const dir = join(root, '.session');
    const cold = fakeModel(readBothFiles);
    const process1 = await openSession(dir);
    const firstTurn = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* createCoderNetwork({ ...options, store: process1.store }).run({
          layers: layers(cold),
        });
        return yield* turn(plane, 'run-1', 'What do a.txt and b.txt contain?', process1.contextId);
      }).pipe(Effect.scoped),
    );
    expect(checkpoints(firstTurn)).toHaveLength(1);
    const coldFrom = cold.requests.length;

    const process2 = await openSession(dir);
    expect(process2).toMatchObject({ resumed: true, contextId: process1.contextId });
    expect(process2.store).not.toBe(process1.store);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* createCoderNetwork({ ...options, store: process2.store }).run({
          layers: layers(cold),
        });
        yield* turn(plane, 'run-2', 'And which one is longer?', process2.contextId);
      }).pipe(Effect.scoped),
    );

    const warmTurn = second(warm.requests, warmFrom);
    const coldTurn = second(cold.requests, coldFrom);
    expect(coldTurn).toEqual(warmTurn);
    // The second turn starts from the first turn's checkpoint: its summary is in the context.
    expect(JSON.stringify(coldTurn[0])).toContain('SUMMARY of');
    expect(JSON.stringify(coldTurn[0])).not.toContain('What do a.txt and b.txt contain?');
    // Nothing was skipped or failed on the way (no `m4trix.fold.read.skipped` warning).
    expect(reported).toEqual([]);

    // The session file: JSON lines, the checkpoint with a cursor of the file store, and no
    // transient event (token deltas, compaction notices).
    const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { contextId: string; event: StoredEvent });
    expect(new Set(lines.map((line) => line.contextId))).toEqual(new Set([process1.contextId]));
    const stored = lines.map((line) => line.event);
    expect(stored.map((event) => event.name)).not.toContain('assistant-delta');
    expect(stored.map((event) => event.name)).not.toContain('context-compacted');
    // One compaction in the first turn, two in the second (before its step and its answer).
    expect(checkpoints(stored).map((event) => event.payload)).toEqual(
      Array.from({ length: 3 }, () => ({
        fold: 'conversation',
        version: 1,
        through: expect.stringMatching(/^jsonl:\d+$/),
        state: { summary: expect.stringContaining('SUMMARY of'), segments: [expect.any(Object)] },
      })),
    );
  });

  test('a long turn compacts once, keeps the newest steps that fit keepTokens, and goes on', async () => {
    // Five files of one 290-character line: each read is a step of 133 tokens (the prompt: 19),
    // all of it kept verbatim (under the 400 characters that elision cuts).
    const files = ['c1.txt', 'c2.txt', 'c3.txt', 'c4.txt', 'c5.txt'];
    for (const [index, file] of files.entries()) {
      await writeFile(join(root, file), `${String(index + 1).repeat(290)}\n`);
    }
    let calls = 0;
    const model = fakeModel((request) => {
      if (request.tools.length === 0) return { text: 'SUMMARY: read c1 and c2.', toolCalls: [] };
      const file = files[calls++];
      return file
        ? { text: `Reading ${file}.`, toolCalls: [call(`call-${calls}`, file)] }
        : { text: 'Read all five files.', toolCalls: [] };
    });
    // Over budget (551 > 450) once four steps are in the turn. A compaction keeps the newest
    // steps within 300 tokens: two (266), where the budget would keep three (399).
    const network = createCoderNetwork({
      instructions: '',
      maxSteps: 10,
      contextBudget: 450,
      keepTokens: 300,
    });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run({
          layers: { Model: model.layer, Workspace: createWorkspace(root) },
        });
        return yield* turn(plane, 'run-1', 'Read the five files.');
      }).pipe(Effect.scoped),
    );

    const steps = events.filter(ModelStep.is).map((event) => event.payload.stepId);
    expect(steps).toHaveLength(5);
    expect(events.find(AssistantMessage.is)?.payload.text).toBe('Read all five files.');
    // One compaction, before the model call that follows the fourth step (the summary call has
    // no tools); the calls after it, a fifth step and the answer, do not compact again.
    expect(model.requests.map((r) => r.tools > 0)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
    // It keeps the newest steps that fit keepTokens (two, not one, not three): the prompt and
    // the two oldest steps are summarized.
    const [checkpoint, ...more] = checkpoints(events);
    expect(more).toEqual([]);
    const kept = (checkpoint?.payload.state as ConversationState).segments;
    expect(kept.map((segment) => segment.id)).toEqual(steps.slice(2, 4));
    // The compacted state fits again: the last call sees the summary and the third to fifth steps.
    const last = model.requests.at(-1)?.messages ?? [];
    expect(last[1]?.content).toContain('SUMMARY: read c1 and c2.');
    expect(last.filter((m) => m.role === 'tool')).toHaveLength(3);
    expectEveryToolCallAnswered(last);
  });

  test('a tool-heavy turn compacts on the elided view, so it summarizes more than the budget, in chunks', async () => {
    // Twenty reads of a 1400-character line: a step is about 400 tokens, about 150 with its output
    // elided to 400 characters (the view elides all but the newest three segments), so a dozen
    // steps pile up elided before the view no longer fits.
    const files = Array.from({ length: 20 }, (_, index) => `big${index + 1}.txt`);
    for (const [index, file] of files.entries()) {
      await writeFile(join(root, file), `${String(index % 10).repeat(1400)}\n`);
    }
    let reads = 0;
    const model = fakeModel((request) => {
      if (request.tools.length === 0) return { text: 'SUMMARY', toolCalls: [] };
      const file = files[reads++];
      return file
        ? { text: '', toolCalls: [call(`call-${reads}`, file)] }
        : { text: 'Read them all.', toolCalls: [] };
    });
    const contextBudget = 3000;
    const network = createCoderNetwork({ instructions: '', maxSteps: 22, contextBudget });
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run({
          layers: { Model: model.layer, Workspace: createWorkspace(root) },
        });
        return yield* turn(plane, 'run-1', 'Read the twenty files.');
      }).pipe(Effect.scoped),
    );
    expect(events.find(AssistantMessage.is)?.payload.text).toBe('Read them all.');

    // The call before the first compaction read a conversation over budget in full, but its view
    // fit (old outputs elided), so it did not compact.
    const tools = model.requests.map((request) => request.tools > 0);
    const first = tools.indexOf(false);
    const all = Conversation.applyAll(
      Conversation.initialState(),
      events.filter((event) => !isFoldCheckpointEvent(event)),
    );
    const seen: ConversationState = { segments: all.segments.slice(0, first) };
    const full = seen.segments.reduce((sum, segment) => sum + ChatView.count(segment), 0);
    expect(full).toBeGreaterThan(contextBudget);
    expect(ChatView(seen, { budget: contextBudget })).toMatchObject({ fits: true, dropped: [] });

    // The first compaction then summarizes the older segments with their outputs in full: more
    // than a budget, so in chunks of at most a budget each.
    const requests: string[] = [];
    for (let index = first; tools[index] === false; index++) {
      requests.push(String(model.requests[index]?.messages[1]?.content));
    }
    const tokens = requests.map((transcript) =>
      Math.ceil(transcript.replace(/^\[Earlier summary\]\n[^\n]*\n\n/, '').length / 4),
    );
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.every((size) => size <= contextBudget)).toEqual(true);
    expect(tokens.reduce((sum, size) => sum + size)).toBeGreaterThan(contextBudget);
  });

  test('after a version bump, the whole re-folded history is summarized, in requests of at most the budget', async () => {
    // Eight turns, each reading a file of one 290-character line and answering: 160 tokens of
    // conversation per turn, so a budget of 450 compacts every two or three turns.
    const files = Array.from({ length: 9 }, (_, index) => `c${index + 1}.txt`);
    for (const [index, file] of files.entries()) {
      await writeFile(join(root, file), `${String(index + 1).repeat(290)}\n`);
    }
    let reads = 0;
    let summaries = 0;
    const model = fakeModel((request) => {
      if (request.tools.length === 0) return { text: `SUMMARY#${++summaries}`, toolCalls: [] };
      if (request.messages.at(-1)?.role === 'user') {
        const file = files[reads++] as string;
        return { text: '', toolCalls: [call(`call-${reads}`, file)] };
      }
      return { text: `Read c${reads}.txt.`, toolCalls: [] };
    });
    const contextBudget = 450;
    const network = (store: AgentNetworkStore) =>
      createCoderNetwork({ instructions: '', maxSteps: 5, contextBudget, store });
    const layers = { Model: model.layer, Workspace: createWorkspace(root) };
    /** What each summary request (a call without tools) is asked to summarize. */
    const summarized = (from: number) =>
      model.requests
        .slice(from)
        .filter((request) => request.tools === 0)
        .map((request) => String(request.messages[1]?.content));
    /** Tokens (≈ characters / 4) of a summary request's segments, without the summary it carries. */
    const segmentTokens = (transcript: string) =>
      Math.ceil(transcript.replace(/^\[Earlier summary\]\n[^\n]*\n\n/, '').length / 4);

    const dir = join(root, '.session');
    const before = await openSession(dir);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network(before.store).run({ layers });
        for (let index = 1; index <= 8; index++) {
          yield* turn(plane, `run-${index}`, `Read file number ${index}.`, before.contextId);
        }
      }).pipe(Effect.scoped),
    );
    const usual = summarized(0);
    expect(usual.length).toBeGreaterThan(1);
    // Nothing is elided here (outputs are under 400 characters): each of them summarizes about
    // what went over the budget since the previous one.
    for (const transcript of usual) {
      expect(segmentTokens(transcript)).toBeLessThanOrEqual(contextBudget);
    }

    // The bump: `Conversation` gets a new version, so the stored checkpoints are another
    // version's. Same effect, without a second fold definition: rewrite them in the session file.
    const file = join(dir, 'events.jsonl');
    const history = await readFile(file, 'utf8');
    const bumped = history
      .replaceAll(
        '"m4trix:fold.checkpoint:conversation@1"',
        '"m4trix:fold.checkpoint:conversation@0"',
      )
      .replaceAll('"fold":"conversation","version":1', '"fold":"conversation","version":0');
    expect(bumped).not.toBe(history);
    await writeFile(file, bumped);

    const from = model.requests.length;
    const after = await openSession(dir);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network(after.store).run({ layers });
        yield* turn(plane, 'run-9', 'Read file number 9.', after.contextId);
      }).pipe(Effect.scoped),
    );

    // The first read folds the whole history again (no checkpoint of its version) and is far
    // over budget: everything but the newest segments is summarized, from scratch.
    const requests = summarized(from);
    const all = requests.join('\n\n');
    // Turns 1 to 7, each exactly once; the eighth is among the newest segments, kept as they are.
    for (let index = 1; index <= 8; index++) {
      expect(all.split(`[User]\nRead file number ${index}.`)).toHaveLength(index < 8 ? 2 : 1);
    }
    expect(requests[0]).not.toContain('[Earlier summary]');
    // In requests of at most the budget each, every one carrying the summary of the one before.
    expect(requests.map(segmentTokens).every((tokens) => tokens <= contextBudget)).toEqual(true);
    expect(requests.length).toBeGreaterThan(1);
    for (const [index, transcript] of requests.slice(1).entries()) {
      expect(transcript).toMatch(
        new RegExp(
          `^\\[Earlier summary\\]\\nSUMMARY#${summaries - requests.length + index + 1}\\n`,
        ),
      );
    }
    // The turn then goes on from the newest summary.
    const last = model.requests.at(-1)?.messages ?? [];
    expect(last[1]?.content).toContain(`SUMMARY#${summaries}`);
  });
});
