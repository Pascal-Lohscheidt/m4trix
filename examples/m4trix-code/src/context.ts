import {
  ContextFold,
  ContextStrategy,
  ContextView,
  type FoldStateOf,
  S,
  type Segment,
  SegmentedFold,
} from '@m4trix/core';
import { AssistantMessage, Entry, ModelStep, ToolResult, UserPrompt } from './events.js';
import type { ChatMessage } from './layers.js';

/**
 * What the model sees, as context folds over the event history:
 *
 * - `Conversation`: every turn of the context as atomic segments (a prompt, a model step with all
 *   of its tool results, an answer), after the summary of the newest compaction, if any. The
 *   model agent compacts it (`folds.conversation.compact(...)`); the runtime stores that as the
 *   fold's checkpoint, so a rebuild starts there too.
 * - `ChatView`: a view of it, read with a token budget (`ChatView(conversation, { budget })`).
 * - `StepProgress`: the steps of the current run and their results (joins a step's fan-out).
 *
 * The runtime caches folded state per context and only folds the events published since the last
 * read, so a step costs one incremental read instead of a replay of the whole conversation.
 */

/** Default token budget of the chat view: well within a 128k+ window, leaving room for output. */
export const DEFAULT_CONTEXT_BUDGET = 100_000;

/**
 * Tokens a compaction keeps verbatim unless configured: the newest segments that fit half the
 * budget. The other half leaves room for the summary and the turns to come, so the view fits
 * again after a compaction instead of compacting on every step.
 */
export const defaultKeepTokens = (budget: number): number => budget / 2;

/** Old tool outputs are cut to this many characters when the view is over budget. */
const ELIDED_OUTPUT_CHARS = 400;

/** Tool outputs of the newest segments are never elided: the model is likely still using them. */
const RECENT_SEGMENTS = 3;

/** Shown in place of a result the step never got (a cancelled or failed turn). */
const MISSING_RESULT = 'No result: the turn was interrupted.';

export const Conversation = SegmentedFold.of('conversation', {
  data: Entry,
  summary: S.String, // what a compaction writes in place of the older segments
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
  // A result joins its step's segment. A late result of a step that was summarized away has no
  // segment any more: it is dropped, which is what we want, so it is not reported either.
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

export type ConversationState = FoldStateOf<typeof Conversation>;
export type ConversationSegment = Segment<Entry>;

function elideOutputs(data: Entry): Entry {
  if (data.kind !== 'step') return data;
  return {
    ...data,
    results: data.results.map((result) =>
      result.output.length <= ELIDED_OUTPUT_CHARS
        ? result
        : {
            ...result,
            output: `${result.output.slice(0, ELIDED_OUTPUT_CHARS)}\n… [elided ${result.output.length - ELIDED_OUTPUT_CHARS} characters; call the tool again if you need them]`,
          },
    ),
  };
}

/**
 * The model's view of the conversation: `ChatView(await folds.conversation(), { budget })`. While
 * it is over budget: first old tool outputs shrink, then whole old segments go, oldest first,
 * never the current turn (from the newest user prompt on). The budget counts the conversation
 * only (≈ JSON chars / 4), not the system prompt or tool schemas.
 */
export const ChatView = ContextView.of(Conversation, {
  strategies: [
    ContextStrategy.elide({
      keepNewest: RECENT_SEGMENTS,
      where: (segment) => segment.data.kind === 'step',
      map: elideOutputs,
    }),
    ContextStrategy.dropOldest({ keepFrom: ContextStrategy.fromNewest(Conversation, 'user') }),
  ],
});

/**
 * Chat messages for a conversation state: the summary of a compaction first, then each segment. A step
 * is followed by one result per tool call, in call order; a call without a result gets a
 * placeholder, since the API rejects unanswered tool calls.
 */
export function toChatMessages(state: ConversationState): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (state.summary) {
    messages.push({
      role: 'system',
      content: `Summary of the earlier conversation (compacted to fit the context budget):\n${state.summary}`,
    });
  }
  for (const { data } of state.segments) {
    if (data.kind === 'user') {
      messages.push({ role: 'user', content: data.text });
    } else if (data.kind === 'answer') {
      messages.push({ role: 'assistant', content: data.text });
    } else {
      messages.push({
        role: 'assistant',
        content: data.text || null,
        tool_calls: data.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of data.toolCalls) {
        const result = data.results.find((candidate) => candidate.callId === call.id);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result?.output ?? MISSING_RESULT,
        });
      }
    }
  }
  return messages;
}

const TRANSCRIPT_OUTPUT_CHARS = 1500;

/** One segment as a compaction's transcript shows it; tool outputs cut to 1500 characters. */
function transcriptOf({ data }: ConversationSegment): string {
  if (data.kind === 'user') return `[User]\n${data.text}`;
  if (data.kind === 'answer') return `[Assistant]\n${data.text}`;
  const lines = data.text ? [`[Assistant]\n${data.text}`] : [];
  for (const call of data.toolCalls) {
    const output = data.results.find((r) => r.callId === call.id)?.output ?? MISSING_RESULT;
    const shown =
      output.length > TRANSCRIPT_OUTPUT_CHARS
        ? `${output.slice(0, TRANSCRIPT_OUTPUT_CHARS)}… [${output.length - TRANSCRIPT_OUTPUT_CHARS} more characters]`
        : output;
    lines.push(`[Tool ${call.name}(${call.arguments})]\n${shown}`);
  }
  return lines.join('\n\n');
}

/** A compaction's (tool-less) model request: summarize the earlier summary plus `older`. */
export function compactionMessages(
  summary: string | undefined,
  older: ReadonlyArray<ConversationSegment>,
): ChatMessage[] {
  const parts = older.map(transcriptOf);
  if (summary) parts.unshift(`[Earlier summary]\n${summary}`);
  return [
    {
      role: 'system',
      content: [
        'You compact the conversation of a terminal coding agent so it can continue the work without the transcript.',
        'The transcript may start with an earlier summary: carry everything in it over (it is the only record of that part), then add what the transcript adds.',
        'Write plain text, at most 250 words: every user request in order, each quoted verbatim; what was explored (files, key facts found); what was changed; decisions; what is still open.',
        'End with the newest user request in this transcript, quoted verbatim.',
        'Write only the summary.',
      ].join('\n'),
    },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * `older` cut into consecutive chunks whose transcripts take at most `maxTokens` (≈ characters /
 * 4) each, for one summary request per chunk: a segment over it is a chunk of its own; no
 * segments, one empty chunk. Compaction needs it in normal operation: the view decides whether
 * the conversation fits after eliding old tool outputs, while `older` holds them in full, so the
 * first compaction of a tool-heavy conversation summarizes well over a budget (about twice, at
 * large budgets). After a `version` bump of `Conversation` (its checkpoints are then ignored), the
 * first one summarizes the whole re-folded history. In chunks, each request carries the summary
 * of the chunks before it.
 */
export function compactionChunks(
  older: ReadonlyArray<ConversationSegment>,
  maxTokens: number,
): [ConversationSegment[], ...ConversationSegment[][]] {
  const chunks: [ConversationSegment[], ...ConversationSegment[][]] = [[]];
  let tokens = 0;
  for (const segment of older) {
    // Its transcript and the blank line before it.
    const cost = Math.ceil((transcriptOf(segment).length + 2) / 4);
    const chunk = chunks[chunks.length - 1] as ConversationSegment[];
    if (chunk.length > 0 && tokens + cost > maxTokens) {
      chunks.push([segment]);
      tokens = cost;
    } else {
      chunk.push(segment);
      tokens += cost;
    }
  }
  return chunks;
}

/* ─── Progress of the current run ─── */

/** What the run's progress keeps per step. */
const StepTally = S.Struct({
  /** Tool calls of the step (unknown until its `model-step` is folded). */
  calls: S.optional(S.Number),
  /** Call ids of its results, in arrival order. */
  results: S.Array(S.String),
});

const Progress = S.Struct({
  /** Model steps (responses with tool calls) in this run. */
  steps: S.Number,
  tally: S.Record({ key: S.String, value: StepTally }),
});
export type Progress = typeof Progress.Type;

/** Run-scoped: the model steps of the current turn and the results each one has. */
export const StepProgress = ContextFold.of('stepProgress', { scope: 'run', state: Progress })
  .initial(() => ({ steps: 0, tally: {} }))
  .on(ModelStep, (progress, { payload }) => ({
    steps: progress.steps + 1,
    tally: {
      ...progress.tally,
      [payload.stepId]: {
        calls: payload.toolCalls.length,
        results: progress.tally[payload.stepId]?.results ?? [],
      },
    },
  }))
  .on(ToolResult, (progress, { payload }) => {
    const tally = progress.tally[payload.stepId];
    return {
      ...progress,
      tally: {
        ...progress.tally,
        [payload.stepId]: { ...tally, results: [...(tally?.results ?? []), payload.callId] },
      },
    };
  });

/**
 * True when the result `callId` is the one that completes step `stepId`. Results are handled
 * concurrently and a read sees every result stored so far, so "all results are in" can be true for
 * several of them; only the result that filled the step's last slot completes it, exactly once.
 */
export function completesStep(progress: Progress, stepId: string, callId: string): boolean {
  const tally = progress.tally[stepId];
  if (tally?.calls === undefined || tally.results.length < tally.calls) return false;
  return tally.results[tally.calls - 1] === callId;
}
