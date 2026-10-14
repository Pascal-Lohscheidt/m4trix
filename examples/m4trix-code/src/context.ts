import {
  ContextFold,
  ContextStrategy,
  type FoldStateOf,
  type Segment,
  SegmentedFold,
  type ViewResult,
} from '@m4trix/core';
import {
  AssistantMessage,
  ContextCompacted,
  type Entry,
  ModelStep,
  ToolResult,
  UserPrompt,
} from './events.js';
import type { ChatMessage } from './layers.js';

/**
 * What the model sees, as context folds over the event history:
 *
 * - `Conversation`: every turn of the context as atomic segments (a prompt, a model step with all
 *   of its tool results, an answer), starting at the newest `context-compacted` checkpoint.
 * - `createChatView(budget)`: the `chat` view of it, trimmed to a token budget.
 * - `StepProgress`: the steps of the current run and their results (joins a step's fan-out).
 *
 * The runtime caches folded state per context and only folds the events published since the last
 * read, so a step costs one incremental read instead of a replay of the whole conversation.
 */

/** Default token budget of the chat view: well within a 128k+ window, leaving room for output. */
export const DEFAULT_CONTEXT_BUDGET = 100_000;

/** Newest segments the compactor keeps verbatim; everything older is summarized. */
export const DEFAULT_KEEP_SEGMENTS = 4;

/** Old tool outputs are cut to this many characters when the view is over budget. */
const ELIDED_OUTPUT_CHARS = 400;

/** Tool outputs of the newest segments are never elided: the model is likely still using them. */
const RECENT_SEGMENTS = 3;

/** Shown in place of a result the step never got (a cancelled or failed turn). */
const MISSING_RESULT = 'No result: the turn was interrupted.';

export const Conversation = SegmentedFold.of('conversation', { version: 1 })
  .over([UserPrompt, ModelStep, ToolResult, AssistantMessage, ContextCompacted])
  .segments<Entry, string>() // segment data, checkpoint (the summary)
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
  // A result joins its step's segment. A late result of a step that was summarized away is
  // dropped (unknown id), which is what we want.
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

export type ConversationState = FoldStateOf<typeof Conversation>;
export type ConversationSegment = Segment<Entry>;

/** Segments from the newest user prompt on: the current turn, which the view never drops. */
function inCurrentTurn(
  _segment: ConversationSegment,
  index: number,
  segments: ReadonlyArray<ConversationSegment>,
): boolean {
  let turnStart = 0;
  segments.forEach((segment, at) => {
    if (segment.data.kind === 'user') turnStart = at;
  });
  return index >= turnStart;
}

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
 * The model's budgeted view of the conversation (`folds.chat()`). While it is over budget: first
 * old tool outputs shrink, then whole old segments go, oldest first, never the current turn.
 * Budget counts the conversation only (≈ JSON chars / 4), not the system prompt or tool schemas.
 */
export function createChatView(budget: number) {
  return Conversation.view('chat', {
    budget,
    strategies: [
      ContextStrategy.elide({
        olderThan: RECENT_SEGMENTS,
        where: (segment) => segment.data.kind === 'step',
        map: elideOutputs,
      }),
      ContextStrategy.dropOldest({ pin: inCurrentTurn }),
    ],
  });
}

export type ChatView = ReturnType<typeof createChatView>;
export type ChatViewResult = ViewResult<ConversationState>;

/**
 * Compact when the view could not keep the whole conversation (it dropped segments, or is still
 * over budget), and only when compacting can help: there are more segments than the compactor
 * keeps verbatim. Otherwise the model works with the view as it is.
 */
export function needsCompaction(chat: ChatViewResult, keep: number): boolean {
  const segments = chat.state.segments.length + chat.dropped.length;
  return (chat.overBudget || chat.dropped.length > 0) && segments > keep;
}

/** The compactor's cut: the newest `keep` segments stay, everything before is summarized. */
export function splitForCompaction(
  state: ConversationState,
  keep: number,
): { older: ConversationSegment[]; kept: ConversationSegment[] } {
  const cut = Math.max(0, state.segments.length - Math.max(1, keep));
  return { older: state.segments.slice(0, cut), kept: state.segments.slice(cut) };
}

/**
 * Chat messages for a conversation state: the checkpoint summary first, then each segment. A step
 * is followed by one result per tool call, in call order; a call without a result gets a
 * placeholder, since the API rejects unanswered tool calls.
 */
export function toChatMessages(state: ConversationState): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (state.checkpoint) {
    messages.push({
      role: 'system',
      content: `Summary of the earlier conversation (compacted to fit the context budget):\n${state.checkpoint}`,
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

/** The compactor's (tool-less) model request: summarize the earlier summary plus `older`. */
export function compactionMessages(
  checkpoint: string | undefined,
  older: ReadonlyArray<ConversationSegment>,
): ChatMessage[] {
  const lines: string[] = [];
  if (checkpoint) lines.push(`[Earlier summary]\n${checkpoint}`);
  for (const { data } of older) {
    if (data.kind === 'user') lines.push(`[User]\n${data.text}`);
    else if (data.kind === 'answer') lines.push(`[Assistant]\n${data.text}`);
    else {
      if (data.text) lines.push(`[Assistant]\n${data.text}`);
      for (const call of data.toolCalls) {
        const output = data.results.find((r) => r.callId === call.id)?.output ?? MISSING_RESULT;
        const shown =
          output.length > TRANSCRIPT_OUTPUT_CHARS
            ? `${output.slice(0, TRANSCRIPT_OUTPUT_CHARS)}… [${output.length - TRANSCRIPT_OUTPUT_CHARS} more characters]`
            : output;
        lines.push(`[Tool ${call.name}(${call.arguments})]\n${shown}`);
      }
    }
  }
  return [
    {
      role: 'system',
      content: [
        'You compact the conversation of a terminal coding agent so it can continue the work without the transcript.',
        'The transcript may start with an earlier summary: carry everything in it over (it is the only record of that part), then add what the transcript adds.',
        'Write plain text, at most 250 words: every user request in order, each quoted verbatim; what was explored (files, key facts found); what was changed; decisions; what is still open.',
        'Write only the summary.',
      ].join('\n'),
    },
    { role: 'user', content: lines.join('\n\n') },
  ];
}

/* ─── Progress of the current run ─── */

type StepTally = {
  /** Tool calls of the step (unknown until its `model-step` is folded). */
  readonly calls?: number;
  /** Call ids of its results, in arrival order. */
  readonly results: readonly string[];
};

export type Progress = {
  /** Model steps (responses with tool calls) in this run. */
  readonly steps: number;
  readonly tally: Readonly<Record<string, StepTally>>;
};

/** Run-scoped: the model steps of the current turn and the results each one has. */
export const StepProgress = ContextFold.of('stepProgress', { version: 1 })
  .scope('run')
  .over([ModelStep, ToolResult])
  .initial((): Progress => ({ steps: 0, tally: {} }))
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
