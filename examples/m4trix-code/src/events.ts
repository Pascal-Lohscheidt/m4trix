import { AgentNetworkEvent, S } from '@m4trix/core';

/**
 * The agent loop as events. One user turn is one run:
 *
 *   user-prompt ─▶ model ─▶ model-step ─┬▶ tool-call-requested ─▶ tool-runner ─▶ tool-result ─┐
 *                    ▲                  └▶ (no tool calls) assistant-message ─▶ run completed │
 *                    └──────────────── step-completed ◀── step-collector (aggregator) ◀───────┘
 *
 * Everything durable lands in the network store, so the store *is* the conversation: the model
 * agent reads it as a budgeted context fold (`src/context.ts`) on every step. When it no longer
 * fits, the model agent asks the compactor (`compaction-requested`), which answers with a
 * `context-compacted` checkpoint.
 */

/** Start event of a turn, published on `main`. */
export const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));

/** Streamed model text. Transient: shown live, never stored. */
export const AssistantDelta = AgentNetworkEvent.of(
  'assistant-delta',
  S.Struct({ text: S.String }),
  { transient: true },
);

export const ToolCall = S.Struct({ id: S.String, name: S.String, arguments: S.String });

/** One model response that asked for tools: the durable record of what the model said and called. */
export const ModelStep = AgentNetworkEvent.of(
  'model-step',
  S.Struct({ stepId: S.String, text: S.String, toolCalls: S.Array(ToolCall) }),
);

/** Fan-out of a model step: one event per tool call. */
export const ToolCallRequested = AgentNetworkEvent.of(
  'tool-call-requested',
  S.Struct({
    stepId: S.String,
    callId: S.String,
    name: S.String,
    arguments: S.String,
    count: S.Number,
  }),
);

export const ToolResult = AgentNetworkEvent.of(
  'tool-result',
  S.Struct({
    stepId: S.String,
    callId: S.String,
    name: S.String,
    ok: S.Boolean,
    output: S.String,
  }),
);

/** Every tool call of a step has a result: the model's turn again. */
export const StepCompleted = AgentNetworkEvent.of('step-completed', S.Struct({ stepId: S.String }));

/** The model's final answer for the turn. Ends the run. */
export const AssistantMessage = AgentNetworkEvent.of(
  'assistant-message',
  S.Struct({ text: S.String }),
);

/**
 * One unit of the conversation the model sees (a segment of the `Conversation` fold): a prompt, a
 * model step together with its tool results, or a final answer. A step and its results are never
 * separated, so the model never gets a tool call without its result.
 */
export const Entry = S.Union(
  S.Struct({ kind: S.Literal('user'), text: S.String }),
  S.Struct({
    kind: S.Literal('step'),
    text: S.String,
    toolCalls: S.Array(ToolCall),
    results: S.Array(S.Struct({ callId: S.String, output: S.String })),
  }),
  S.Struct({ kind: S.Literal('answer'), text: S.String }),
);
export type Entry = typeof Entry.Type;

/** The model agent asks the compactor to compact the conversation (an `emitAndAwait`). */
export const CompactionRequested = AgentNetworkEvent.of(
  'compaction-requested',
  S.Struct({
    /** Tokens of the chat view, and its budget, when compaction was asked for. */
    tokens: S.Number,
    budget: S.Number,
    /** Newest segments to keep verbatim; everything older is summarized. */
    keep: S.Number,
  }),
);

/**
 * The compactor's answer and the conversation's checkpoint: self-contained, it replaces the folded
 * state (a summary of everything older, plus the segments kept verbatim). A cold rebuild of the
 * conversation starts at the newest one.
 */
export const ContextCompacted = AgentNetworkEvent.of(
  'context-compacted',
  S.Struct({
    summary: S.String,
    kept: S.Array(S.Struct({ id: S.String, data: Entry })),
    /** How many segments the summary replaced (for display). */
    summarized: S.Number,
  }),
);

/** A tool wants to change something; answered by the client with `permission-resolved`. */
export const PermissionRequested = AgentNetworkEvent.of(
  'permission-requested',
  S.Struct({ requestId: S.String, tool: S.String, summary: S.String, detail: S.String }),
);

export const PermissionResolved = AgentNetworkEvent.of(
  'permission-resolved',
  S.Struct({ requestId: S.String, approved: S.Boolean, reason: S.optional(S.String) }),
);
