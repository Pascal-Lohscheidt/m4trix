import { AgentNetworkEvent, S } from '@m4trix/core';

export const MessageEvent = AgentNetworkEvent.of(
  'message',
  S.Struct({ message: S.String, role: S.String }),
);

export const MessageStreamChunkEvent = AgentNetworkEvent.of(
  'message-stream-chunk',
  S.Struct({ chunk: S.String, isFinal: S.Boolean, role: S.String }),
);

export const ToolUsedEvent = AgentNetworkEvent.of(
  'tool-used',
  S.Struct({
    toolCallId: S.String,
    toolName: S.String,
    phase: S.Literal('start', 'end'),
    input: S.optional(S.Unknown),
    output: S.optional(S.Unknown),
    error: S.optional(S.String),
  }),
);

/** Published on the sub channel to start a background sub-agent run. */
export const SubAgentTaskRequested = AgentNetworkEvent.of(
  'sub-agent-task-requested',
  S.Struct({
    taskId: S.String,
    prompt: S.String,
  }),
);

/** Emitted when a background sub-agent finishes; completes matching emitAndAwait. */
export const SubAgentTaskCompleted = AgentNetworkEvent.of(
  'sub-agent-task-completed',
  S.Struct({
    taskId: S.String,
    status: S.Literal('completed', 'failed'),
    result: S.String,
    error: S.optional(S.String),
  }),
);

/** Streamed to the CLI when a tool wants to run a shell command (human approval required). */
export const CommandApprovalRequested = AgentNetworkEvent.of(
  'command-approval-requested',
  S.Struct({
    requestId: S.String,
    command: S.String,
    cwd: S.String,
    reason: S.optional(S.String),
  }),
);

/** Published by the CLI after the user approves or denies; completes emitAndAwait in the tool. */
export const CommandApprovalResolved = AgentNetworkEvent.of(
  'command-approval-resolved',
  S.Struct({
    requestId: S.String,
    approved: S.Boolean,
    denialReason: S.optional(S.String),
  }),
);
