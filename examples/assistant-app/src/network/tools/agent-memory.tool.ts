import { S, Tool } from '@m4trix/core';

import { WithAgentMemoryLayer } from '../depedency-layers/with-agent-memory.js';
import { ToolUsedEvent } from '../events.js';

type ToolUsedEmit = (event: ReturnType<typeof ToolUsedEvent.make>) => void;

const memoryRecordSchema = S.Struct({
  id: S.String,
  title: S.String,
  content: S.String,
  updatedAt: S.String,
});

const subAgentRecordSchema = S.Struct({
  id: S.String,
  name: S.String,
  description: S.String,
  systemPrompt: S.String,
  updatedAt: S.String,
});

function emitStart(
  emit: ToolUsedEmit,
  options: { toolCallId: string; toolName: string; input?: unknown },
): void {
  emit(
    ToolUsedEvent.make({
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      phase: 'start',
      input: options.input,
    }),
  );
}

function emitEnd(
  emit: ToolUsedEmit,
  options: { toolCallId: string; toolName: string; output?: unknown },
): void {
  emit(
    ToolUsedEvent.make({
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      phase: 'end',
      output: options.output,
    }),
  );
}

function emitError(
  emit: ToolUsedEmit,
  options: { toolCallId: string; toolName: string; error: unknown },
): void {
  emit(
    ToolUsedEvent.make({
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      phase: 'end',
      error: options.error instanceof Error ? options.error.message : String(options.error),
    }),
  );
}

export const listMemoriesTool = Tool.of({
  name: 'listMemories',
  description: 'List long-lived assistant memories stored in agent memory.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({}))
  .output(S.Struct({ memories: S.Array(memoryRecordSchema) }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ layers, emit, toolCallId }) => {
    const toolName = 'listMemories';
    emitStart(emit, { toolCallId, toolName });

    try {
      const output = { memories: await layers.WithAgentMemoryLayer.listMemories() };
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const readMemoryTool = Tool.of({
  name: 'readMemory',
  description: 'Read one long-lived assistant memory by id.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ id: S.String }))
  .output(S.Struct({ memory: S.optional(memoryRecordSchema) }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    const toolName = 'readMemory';
    emitStart(emit, { toolCallId, toolName, input });

    try {
      const memory = await layers.WithAgentMemoryLayer.readMemory(input.id);
      const output = memory ? { memory } : {};
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const writeMemoryTool = Tool.of({
  name: 'writeMemory',
  description: 'Create or replace a long-lived assistant memory by id.',
})
  .emits([ToolUsedEvent])
  .input(
    S.Struct({
      id: S.String,
      title: S.String,
      content: S.String,
    }),
  )
  .output(S.Struct({ memory: memoryRecordSchema }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    const toolName = 'writeMemory';
    emitStart(emit, {
      toolCallId,
      toolName,
      input: { id: input.id, title: input.title },
    });

    try {
      const output = { memory: await layers.WithAgentMemoryLayer.writeMemory(input) };
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const readSystemPromptTool = Tool.of({
  name: 'readSystemPrompt',
  description: 'Read the persisted assistant system prompt memory file.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({}))
  .output(S.Struct({ systemPrompt: S.String }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ layers, emit, toolCallId }) => {
    const toolName = 'readSystemPrompt';
    emitStart(emit, { toolCallId, toolName });

    try {
      const output = { systemPrompt: await layers.WithAgentMemoryLayer.loadSystemPrompt() };
      emitEnd(emit, { toolCallId, toolName, output: { bytes: output.systemPrompt.length } });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const writeSystemPromptTool = Tool.of({
  name: 'writeSystemPrompt',
  description: 'Replace the persisted assistant system prompt memory file.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ contents: S.String }))
  .output(S.Struct({ written: S.Boolean }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    const toolName = 'writeSystemPrompt';
    emitStart(emit, {
      toolCallId,
      toolName,
      input: { bytes: input.contents.length },
    });

    try {
      await layers.WithAgentMemoryLayer.writeSystemPrompt(input.contents);
      const output = { written: true };
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const listSubAgentsTool = Tool.of({
  name: 'listSubAgents',
  description: 'List stored sub-agent definitions from agent memory.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({}))
  .output(S.Struct({ subAgents: S.Array(subAgentRecordSchema) }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ layers, emit, toolCallId }) => {
    const toolName = 'listSubAgents';
    emitStart(emit, { toolCallId, toolName });

    try {
      const output = { subAgents: await layers.WithAgentMemoryLayer.listSubAgents() };
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const readSubAgentTool = Tool.of({
  name: 'readSubAgent',
  description: 'Read one stored sub-agent definition by id.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ id: S.String }))
  .output(S.Struct({ subAgent: S.optional(subAgentRecordSchema) }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    const toolName = 'readSubAgent';
    emitStart(emit, { toolCallId, toolName, input });

    try {
      const subAgent = await layers.WithAgentMemoryLayer.readSubAgent(input.id);
      const output = subAgent ? { subAgent } : {};
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const writeSubAgentTool = Tool.of({
  name: 'writeSubAgent',
  description: 'Create or replace a stored sub-agent definition by id.',
})
  .emits([ToolUsedEvent])
  .input(
    S.Struct({
      id: S.String,
      name: S.String,
      description: S.String,
      systemPrompt: S.String,
    }),
  )
  .output(S.Struct({ subAgent: subAgentRecordSchema }))
  .dependsOn(WithAgentMemoryLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    const toolName = 'writeSubAgent';
    emitStart(emit, {
      toolCallId,
      toolName,
      input: { id: input.id, name: input.name },
    });

    try {
      const output = { subAgent: await layers.WithAgentMemoryLayer.writeSubAgent(input) };
      emitEnd(emit, { toolCallId, toolName, output });
      return output;
    } catch (error) {
      emitError(emit, { toolCallId, toolName, error });
      throw error;
    }
  });

export const agentMemoryTools = [
  listMemoriesTool,
  readMemoryTool,
  writeMemoryTool,
  readSystemPromptTool,
  writeSystemPromptTool,
  listSubAgentsTool,
  readSubAgentTool,
  writeSubAgentTool,
];
