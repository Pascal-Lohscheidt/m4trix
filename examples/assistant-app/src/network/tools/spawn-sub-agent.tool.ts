import { S, Tool } from '@m4trix/core';

import {
  SubAgentTaskCompleted,
  SubAgentTaskRequested,
  ToolUsedEvent,
} from '../events.js';

export const spawnSubAgentTool = Tool.of({
  name: 'spawnSubAgent',
  description:
    'Delegate a complex task to a background sub-agent that can use the same web, filesystem, and memory tools. Waits up to one minute for the sub-agent to finish and returns its result.',
})
  .emits([ToolUsedEvent, SubAgentTaskRequested])
  .input(
    S.Struct({
      prompt: S.String,
    }),
  )
  .output(
    S.Struct({
      taskId: S.String,
      status: S.Literal('completed', 'failed'),
      result: S.String,
      error: S.optional(S.String),
    }),
  )
  .define(async ({ input, emit, emitAndAwait, toolCallId }) => {
    const toolName = 'spawnSubAgent';
    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName,
        phase: 'start',
        input: { prompt: input.prompt },
      }),
    );

    try {
      const reply = await emitAndAwait(
        SubAgentTaskRequested.make({
          taskId: toolCallId,
          prompt: input.prompt,
        }),
        SubAgentTaskCompleted.is,
        { timeout: '1 minute' },
      );

      if (!SubAgentTaskCompleted.is(reply)) {
        throw new Error('Sub-agent reply did not match sub-agent-task-completed');
      }

      const output = {
        taskId: reply.payload.taskId,
        status: reply.payload.status,
        result: reply.payload.result,
        error: reply.payload.error,
      };

      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName,
          phase: 'end',
          output,
        }),
      );

      return output;
    } catch (error) {
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName,
          phase: 'end',
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  });
