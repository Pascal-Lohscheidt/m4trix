/**
 * End to end over the pure parts: the m4trix-code conversation (examples/m4trix-code) as a
 * segmented fold, a budgeted chat view of it and a compaction checkpoint. A model step and its
 * tool results form one segment, so the view can trim the conversation to any budget without
 * ever sending the model a tool call without its result (which the chat APIs reject).
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { EnvelopeLike } from '../agent-network/agent-network-event.js';
import { AgentNetworkEvent, S } from '../agent-network/agent-network-event.js';
import type { FoldResultOf, FoldStateOf } from './context-fold.js';
import { type Segment, SegmentedFold, type SegmentedState } from './segmented-fold.js';
import { ContextStrategy } from './strategies.js';
import { approxTokenCount, type ViewResult } from './view.js';

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

/** The compactor's checkpoint: a summary of what it dropped and the segments it kept. */
const ContextCompacted = AgentNetworkEvent.of(
  'context-compacted',
  S.Struct({ summary: S.String, kept: S.Array(S.Struct({ id: S.String, data: Entry })) }),
);

/* ─── The fold and its view ─── */

const Conversation = SegmentedFold.of('conversation', { version: 1 })
  .over([UserPrompt, ModelStep, ToolResult, AssistantMessage, ContextCompacted])
  .segments<Entry, string>()
  .on(UserPrompt, (state, { meta, payload }) =>
    SegmentedFold.open(state, `prompt:${meta.runId}`, { kind: 'user', text: payload.text }),
  )
  .on(ModelStep, (state, { payload }) =>
    SegmentedFold.open(state, payload.stepId, {
      kind: 'step',
      text: payload.text,
      toolCalls: payload.toolCalls,
      results: [],
    }),
  )
  .on(ToolResult, (state, { payload }) =>
    SegmentedFold.attach(state, payload.stepId, (data) =>
      data.kind === 'step'
        ? {
            ...data,
            results: [...data.results, { callId: payload.callId, output: payload.output }],
          }
        : data,
    ),
  )
  .on(AssistantMessage, (state, { meta, payload }) =>
    SegmentedFold.open(state, `answer:${meta.runId}`, { kind: 'answer', text: payload.text }),
  )
  .checkpointOn(ContextCompacted, ({ payload }) => ({
    checkpoint: payload.summary,
    segments: payload.kept,
  }));

type Conversation = FoldStateOf<typeof Conversation>;

/** Segments from the newest user prompt on: the current turn, which the view must keep. */
const inCurrentTurn = (
  _segment: Segment<Entry>,
  index: number,
  segments: ReadonlyArray<Segment<Entry>>,
) => {
  let start = 0;
  segments.forEach((segment, at) => {
    if (segment.data.kind === 'user') start = at;
  });
  return index >= start;
};

/** Old tool outputs shrink first; whole old segments go next; the current turn stays. */
const chatView = (budget: number) =>
  Conversation.view('chat', {
    budget,
    strategies: [
      ContextStrategy.elide({
        olderThan: 2,
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
      ContextStrategy.dropOldest({ pin: inCurrentTurn }),
    ],
  });

/* ─── Rendering, as m4trix-code's toMessages ─── */

type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; tool_calls: ReadonlyArray<{ id: string }> }
  | { role: 'tool'; tool_call_id: string; content: string };

function toMessages(state: Conversation): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (state.checkpoint !== undefined) {
    messages.push({ role: 'system', content: `Earlier: ${state.checkpoint}` });
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

  test('a generous budget keeps everything', () => {
    const state = folded();
    const result = chatView(100_000).select(state);

    expect(result.overBudget).toBe(false);
    expect(result.dropped).toEqual([]);
    expect(result.state).toBe(state);
    expectTypeOf<FoldResultOf<ReturnType<typeof chatView>>>().toEqualTypeOf<
      ViewResult<SegmentedState<Entry, string>>
    >();
  });

  test('a tight budget elides old tool outputs first, then drops whole old segments', () => {
    const state = folded();
    const full = chatView(100_000).select(state).tokens;
    const elidedOnly = chatView(full - 1).select(state);

    expect(elidedOnly.dropped).toEqual([]);
    const step = elidedOnly.state.segments[1]?.data;
    expect(step?.kind === 'step' && step.results.every((r) => r.output.endsWith('[elided]'))).toBe(
      true,
    );

    const tight = chatView(elidedOnly.tokens - 1).select(state);
    expect(tight.dropped[0]).toBe('prompt:run-1');
    expect(tight.overBudget).toBe(false);
  });

  test.each([
    1, 50, 100, 150, 200, 300, 400, 600, 800, 1200, 2000,
  ])('at budget %i the view never separates a step from its results and keeps the current turn', (budget) => {
    const result = chatView(budget).select(folded());

    expectEveryToolCallAnswered(toMessages(result.state));
    expect(ids(result.state).slice(-2)).toEqual(['prompt:run-2', 'step-2']);
    expect(result.tokens).toBe(
      result.state.segments.reduce((sum, segment) => sum + approxTokenCount(segment), 0),
    );
    expect(result.overBudget).toBe(result.tokens > budget);
    for (const id of result.dropped) expect(ids(result.state)).not.toContain(id);
  });

  test('when over budget the model compacts: the checkpoint replaces what the view dropped', () => {
    const before = chatView(40).select(folded());
    // The current turn is pinned and alone exceeds 40 tokens: the view cannot fit the budget.
    expect(before.overBudget).toBe(true);
    expect(before.dropped).toEqual(['prompt:run-1', 'step-1', 'answer:run-1']);

    // The compactor summarizes the dropped segments and keeps the rest of the view (m4trix-code
    // asks the model for the summary; here it is fixed).
    const compaction = event('run-2', ContextCompacted, {
      summary: 'The user asked what a.ts and b.ts export; both export `line`.',
      kept: before.state.segments,
    });
    const after = [
      compaction,
      event('run-2', ToolResult, {
        stepId: 'step-1',
        callId: 'call-a',
        name: 'read_file',
        ok: true,
        output: 'a late result of a compacted step: ignored',
      }),
      event('run-2', AssistantMessage, { text: 'Renamed `line` to `row` in a.ts.' }),
    ];

    const state = Conversation.applyAll(folded(), after);
    const coldRead = Conversation.applyAll(Conversation.initialState(), after);

    expect(state).toEqual(coldRead);
    expect(state.checkpoint).toBe('The user asked what a.ts and b.ts export; both export `line`.');
    expect(ids(state)).toEqual(['prompt:run-2', 'step-2', 'answer:run-2']);
    const messages = toMessages(chatView(10_000).select(state).state);
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Earlier: The user asked what a.ts and b.ts export; both export `line`.',
    });
    expectEveryToolCallAnswered(messages);
    expect(chatView(10_000).select(state).tokens).toBe(
      approxTokenCount(state.checkpoint) +
        state.segments.reduce((sum, segment) => sum + approxTokenCount(segment), 0),
    );
  });
});
