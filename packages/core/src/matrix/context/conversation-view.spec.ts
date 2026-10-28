/**
 * End to end over the pure parts: the m4trix-code conversation (examples/m4trix-code) as a
 * segmented fold, a chat view of it read at any budget and a compaction cut by tokens.
 * A model step and its tool results form one segment, so the view can trim the conversation to
 * any budget without ever sending the model a tool call without its result (which the chat APIs
 * reject).
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { EnvelopeLike } from '../agent-network/agent-network-event.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import type { FoldStateOf } from './context-fold.js';
import { type Segment, SegmentedFold } from './segmented-fold.js';
import { ContextStrategy } from './strategies.js';
import { approxTokenCount, ContextView, type ViewResult } from './view.js';

/* ─── The m4trix-code events ─── */

const ToolCall = S.Struct({ id: S.String, name: S.String, arguments: S.String });
const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const ModelStep = AgentNetworkEvent.of(
  'model-step',
  S.Struct({ stepId: S.String, text: S.String, toolCalls: S.Array(ToolCall) }),
);
const ToolResult = AgentNetworkEvent.of(
  'tool-result',
  S.Struct({ stepId: S.String, callId: S.String, name: S.String, ok: S.Boolean, output: S.String }),
);
const AssistantMessage = AgentNetworkEvent.of('assistant-message', S.Struct({ text: S.String }));

/** What a segment holds: a prompt, a model step with its tool results, or a final answer. */
const Entry = S.Union(
  S.Struct({ kind: S.Literal('user'), text: S.String }),
  S.Struct({
    kind: S.Literal('step'),
    text: S.String,
    toolCalls: S.Array(ToolCall),
    results: S.Array(S.Struct({ callId: S.String, output: S.String })),
  }),
  S.Struct({ kind: S.Literal('answer'), text: S.String }),
);
type Entry = typeof Entry.Type;

/* ─── The fold and its view ─── */

const Conversation = SegmentedFold.of('conversation', {
  data: Entry,
  summary: S.String, // what a compaction writes
  tag: 'kind',
})
  .open(UserPrompt, ({ meta, payload }) => ({
    id: `prompt:${meta.runId}`,
    data: { kind: 'user', text: payload.text },
  }))
  .open(ModelStep, ({ payload }) => ({
    id: payload.stepId,
    data: { kind: 'step', text: payload.text, toolCalls: payload.toolCalls, results: [] },
  }))
  // A result joins its step; a late result of a step a compaction summarized away is ignored.
  .attach(ToolResult, {
    kind: 'step',
    to: ({ payload }) => payload.stepId,
    onMissing: 'ignore',
    update: (step, { payload }) => ({
      ...step,
      results: [...step.results, { callId: payload.callId, output: payload.output }],
    }),
  })
  .open(AssistantMessage, ({ meta, payload }) => ({
    id: `answer:${meta.runId}`,
    data: { kind: 'answer', text: payload.text },
  }));

type Conversation = FoldStateOf<typeof Conversation>;

/** Old tool outputs shrink first; whole old segments go next; the current turn stays. */
const ChatView = ContextView.of(Conversation, {
  strategies: [
    ContextStrategy.elide({
      keepNewest: 2,
      where: (segment) => segment.data.kind === 'step',
      map: (data) =>
        data.kind === 'step'
          ? {
              ...data,
              results: data.results.map((result) => ({
                ...result,
                output: `${result.output.slice(0, 20)}… [elided]`,
              })),
            }
          : data,
    }),
    // The current turn: from the newest user prompt on.
    ContextStrategy.dropOldest({ keepFrom: ContextStrategy.fromNewest(Conversation, 'user') }),
  ],
});
const chatView = (state: Conversation, budget: number) => ChatView(state, { budget });
/** A compaction's cut: the newest segments that fit, and always the newest (the model works on it). */
const compactionCut = (state: Conversation, keepTokens: number) =>
  ChatView.split(state, { keepTokens, keepFrom: ContextStrategy.newest() });

/* ─── Rendering, as m4trix-code's toMessages ─── */

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; tool_calls: ReadonlyArray<{ id: string }> }
  | { role: 'tool'; tool_call_id: string; content: string };

function toMessages(state: Conversation): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (state.summary !== undefined) {
    messages.push({ role: 'system', content: `Earlier: ${state.summary}` });
  }
  for (const { data } of state.segments) {
    if (data.kind === 'user') messages.push({ role: 'user', content: data.text });
    else if (data.kind === 'answer') messages.push({ role: 'assistant', content: data.text });
    else {
      messages.push({ role: 'assistant', content: data.text, tool_calls: data.toolCalls });
      for (const call of data.toolCalls) {
        const result = data.results.find((candidate) => candidate.callId === call.id);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result?.output ?? 'No result: the turn was interrupted.',
        });
      }
    }
  }
  return messages;
}

/** The chat API's rule: every tool call is answered right after the message that made it. */
function expectEveryToolCallAnswered(messages: ChatMessage[]) {
  messages.forEach((message, index) => {
    if (!('tool_calls' in message)) return;
    const answers = messages.slice(index + 1, index + 1 + message.tool_calls.length);
    expect(
      answers.map((answer) => ('tool_call_id' in answer ? answer.tool_call_id : null)),
    ).toEqual(message.tool_calls.map((call) => call.id));
  });
}

/* ─── A recorded conversation ─── */

const event = (
  runId: string,
  def: { makeBound(meta: { runId: string; contextId: string }, payload: never): EnvelopeLike },
  payload: unknown,
) => def.makeBound({ runId, contextId: 'chat-1' }, payload as never);

const bigOutput = (file: string) => `// ${file}\n${'const line = 1;\n'.repeat(60)}`;

/** Turn 1 reads two files and answers; turn 2 is in progress (one step, its result). */
const history: EnvelopeLike[] = [
  event('run-1', UserPrompt, { text: 'What do a.ts and b.ts export?' }),
  event('run-1', ModelStep, {
    stepId: 'step-1',
    text: 'Reading both files.',
    toolCalls: [
      { id: 'call-a', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { id: 'call-b', name: 'read_file', arguments: '{"path":"b.ts"}' },
    ],
  }),
  event('run-1', ToolResult, {
    stepId: 'step-1',
    callId: 'call-b',
    name: 'read_file',
    ok: true,
    output: bigOutput('b.ts'),
  }),
  event('run-1', ToolResult, {
    stepId: 'step-1',
    callId: 'call-a',
    name: 'read_file',
    ok: true,
    output: bigOutput('a.ts'),
  }),
  event('run-1', AssistantMessage, { text: 'a.ts exports `line`; b.ts too.' }),
  event('run-2', UserPrompt, { text: 'Rename `line` to `row` in a.ts.' }),
  event('run-2', ModelStep, {
    stepId: 'step-2',
    text: 'Editing a.ts.',
    toolCalls: [{ id: 'call-c', name: 'edit_file', arguments: '{"path":"a.ts"}' }],
  }),
  event('run-2', ToolResult, {
    stepId: 'step-2',
    callId: 'call-c',
    name: 'edit_file',
    ok: true,
    output: 'Edited a.ts: 60 replacements.',
  }),
];

const folded = () => Conversation.applyAll(Conversation.initialState(), history);
const ids = (state: Conversation) => state.segments.map((segment) => segment.id);

describe('m4trix-code conversation, end to end', () => {
  test('folds into atomic segments: each step carries all of its tool results', () => {
    const state = folded();

    expect(ids(state)).toEqual([
      'prompt:run-1',
      'step-1',
      'answer:run-1',
      'prompt:run-2',
      'step-2',
    ]);
    const step = state.segments[1]?.data;
    expect(step?.kind === 'step' && step.results.map((result) => result.callId)).toEqual([
      'call-b',
      'call-a',
    ]);
    expectEveryToolCallAnswered(toMessages(state));
  });

  test('a generous budget keeps everything: the view fits', () => {
    const state = folded();
    const result = chatView(state, 100_000);

    expect(result).toMatchObject({ overBudget: false, dropped: [], fits: true });
    expect(result.state).toBe(state);
    expectTypeOf(result).toEqualTypeOf<ViewResult<Conversation>>();
  });

  test('a tight budget elides old tool outputs first (still fits), then drops old segments', () => {
    const state = folded();
    const full = chatView(state, 100_000).tokens;
    const elidedOnly = chatView(state, full - 1);

    expect(elidedOnly).toMatchObject({ dropped: [], fits: true });
    const step = elidedOnly.state.segments[1]?.data;
    expect(step?.kind === 'step' && step.results.every((r) => r.output.endsWith('[elided]'))).toBe(
      true,
    );

    const tight = chatView(state, elidedOnly.tokens - 1);
    expect(tight.dropped[0]).toBe('prompt:run-1');
    expect(tight).toMatchObject({ overBudget: false, fits: false });
  });

  test.each([
    1, 50, 100, 150, 200, 300, 400, 600, 800, 1200, 2000,
  ])('at budget %i the view never separates a step from its results and keeps the current turn', (budget) => {
    const result = chatView(folded(), budget);

    expectEveryToolCallAnswered(toMessages(result.state));
    expect(ids(result.state).slice(-2)).toEqual(['prompt:run-2', 'step-2']);
    expect(result.tokens).toBe(
      result.state.segments.reduce((sum, segment) => sum + approxTokenCount(segment), 0),
    );
    expect(result.overBudget).toBe(result.tokens > budget);
    expect(result.fits).toBe(!result.overBudget && result.dropped.length === 0);
    for (const id of result.dropped) expect(ids(result.state)).not.toContain(id);
  });

  test('when the view does not fit, a compaction cut by tokens makes it fit again', () => {
    const conversation = folded();
    // A budget the view can only meet by dropping segments: it does not fit.
    const budget = chatView(conversation, chatView(conversation, 100_000).tokens - 1).tokens - 1;
    const before = chatView(conversation, budget);
    expect(before).toMatchObject({ fits: false, overBudget: false });

    // The compactor keeps the newest segments that fit half the budget (at least the newest
    // one) and summarizes the rest (m4trix-code asks the model for the summary; here it is fixed).
    const keepTokens = budget / 2;
    const { older, kept } = compactionCut(conversation, keepTokens);
    const keptTokens = kept.reduce((sum, segment) => sum + ChatView.count(segment), 0);
    expect([...older, ...kept]).toEqual(conversation.segments);
    expect(older.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(keptTokens).toBeLessThanOrEqual(keepTokens);
    expect(keptTokens + ChatView.count(older.at(-1) as Segment<Entry>)).toBeGreaterThan(keepTokens);
    // The compacted state (what folds.conversation.compact() checkpoints): the summary and the
    // kept segments. It is stored encoded with the fold's state schema and decoded on read.
    const compacted: Conversation = {
      summary: 'The user asked what a.ts and b.ts export; both export `line`.',
      segments: kept,
    };
    const stored = S.encodeSync(Conversation.stateSchema)(compacted);
    expect(S.decodeUnknownSync(Conversation.stateSchema)(stored)).toEqual(compacted);
    const after = [
      event('run-2', ToolResult, {
        stepId: 'step-1',
        callId: 'call-a',
        name: 'read_file',
        ok: true,
        output: 'a late result of a compacted step: ignored',
      }),
      event('run-2', AssistantMessage, { text: 'Renamed `line` to `row` in a.ts.' }),
    ];

    const state = Conversation.applyAll(compacted, after);

    expect(state.summary).toBe('The user asked what a.ts and b.ts export; both export `line`.');
    expect(ids(state)).toEqual([...ids({ segments: kept }), 'answer:run-2']);
    // The next read fits: no compaction on every step.
    const next = chatView(state, budget);
    expect(next.fits).toBe(true);
    const messages = toMessages(next.state);
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Earlier: The user asked what a.ts and b.ts export; both export `line`.',
    });
    expectEveryToolCallAnswered(messages);
    expect(next.tokens).toBe(
      approxTokenCount(state.summary) +
        state.segments.reduce((sum, segment) => sum + approxTokenCount(segment), 0),
    );
  });

  test('when compacting cannot help (nothing older to summarize), split says so', () => {
    // After a compaction that kept only the newest step, which alone is over the budget.
    const step = folded().segments.at(-1) as Segment<Entry>;
    const state: Conversation = { summary: 'summary', segments: [step] };

    const result = chatView(state, 20);

    expect(result).toMatchObject({ fits: false, overBudget: true, dropped: [] });
    // A compaction would only summarize the summary again: the caller should not compact.
    expect(compactionCut(state, 10)).toEqual({
      older: [],
      kept: [step],
    });
  });
});
