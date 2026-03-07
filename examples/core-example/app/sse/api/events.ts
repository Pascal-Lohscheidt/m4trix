import { AgentNetworkEvent, S } from '@m4trix/core';

export const MessageEvent = AgentNetworkEvent.of(
  'message',
  S.Struct({ message: S.String, role: S.String }),
);

export const MessageStreamChunkEvent = AgentNetworkEvent.of(
  'message-stream-chunk',
  S.Struct({ chunk: S.String, isFinal: S.Boolean, role: S.String }),
);

export const ReasoningForProblemReuqested = AgentNetworkEvent.of(
  'reasoning-for-problem-requested',
  S.Struct({ problemToSolve: S.String }),
);

export const ReasoningForProblemThoughtChunkCreated = AgentNetworkEvent.of(
  'reasoning-for-problem-thought-chunk-created',
  S.Struct({ chunk: S.String }),
);

export const ReasoningForProblemCompleted = AgentNetworkEvent.of(
  'reasoning-for-problem-completed',
  S.Struct({ result: S.String }),
);
