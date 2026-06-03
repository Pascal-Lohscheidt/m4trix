import { AgentFactory } from '@m4trix/core';

import { coreAssistantTools } from './assistant-tools.js';
import { SubAgentTaskCompleted, SubAgentTaskRequested, ToolUsedEvent } from './events.js';
import {
  createAssistantReactAgent,
  streamReactAgentReply,
} from './langchain/react-agent.js';

function formatMemoryContext(snapshot: {
  systemPrompt: string;
  memories: ReadonlyArray<{ id: string; title: string; content: string }>;
}): string {
  const sections = [`### System Prompt Memory\n${snapshot.systemPrompt.trim()}`];

  if (snapshot.memories.length > 0) {
    sections.push(
      `### Memories\n${snapshot.memories
        .map((memory) => `- ${memory.id}: ${memory.title}\n${memory.content}`)
        .join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

const SUB_AGENT_SYSTEM_NOTE = `You are a background sub-agent. Complete the task described in the user message using the available tools. Be thorough but concise in your final answer.`;

/**
 * Long-running worker agent: listens on the sub channel, runs the same tool surface as
 * the main assistant, and emits SubAgentTaskCompleted so the spawn tool's emitAndAwait resolves.
 */
export const backgroundSubAgent = AgentFactory.run()
  .listensTo([SubAgentTaskRequested])
  .emits([SubAgentTaskCompleted, ToolUsedEvent])
  .tools([...coreAssistantTools])
  .logic(async ({ triggerEvent, emit, tools, layers, tracing }) => {
    if (!SubAgentTaskRequested.is(triggerEvent)) {
      return;
    }

    const { taskId, prompt } = triggerEvent.payload;

    try {
      await layers.WithAgentMemoryLayer.init();
      const memoryContext = formatMemoryContext(await layers.WithAgentMemoryLayer.loadSnapshot());
      const reactAgent = createAssistantReactAgent(tools.toTools(), {
        memoryContext: `${SUB_AGENT_SYSTEM_NOTE}\n\n${memoryContext}`,
      });

      const result = await streamReactAgentReply({
        agent: reactAgent,
        messages: [{ role: 'user', content: prompt }],
        tracing,
        onToken: () => {},
      });

      emit(
        SubAgentTaskCompleted.make({
          taskId,
          status: 'completed',
          result,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(
        SubAgentTaskCompleted.make({
          taskId,
          status: 'failed',
          result: '',
          error: message,
        }),
      );
    }
  })
  .produce({});
