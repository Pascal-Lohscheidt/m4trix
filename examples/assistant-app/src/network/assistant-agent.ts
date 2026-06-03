import { AgentFactory } from '@m4trix/core';

import { mainAssistantTools } from './assistant-tools.js';
import { MessageEvent, MessageStreamChunkEvent, ToolUsedEvent } from './events.js';
import {
  createAssistantReactAgent,
  streamReactAgentReply,
  type ChatMessage,
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

export const assistantAgent = AgentFactory.run()
  .listensTo([MessageEvent])
  .emits([MessageStreamChunkEvent, MessageEvent, ToolUsedEvent])
  .tools([...mainAssistantTools])
  .logic(async ({ triggerEvent, emit, contextEvents, tracing, tools, layers }) => {
    if (!MessageEvent.is(triggerEvent)) {
      return;
    }

    const message = triggerEvent.payload.message;
    const role = triggerEvent.payload.role as 'user' | 'assistant';
    const messageHistory = contextEvents.all
      .filter(MessageEvent.is)
      .filter((event) => event.payload.message !== message || event.payload.role !== role);

    const chatMessages: ChatMessage[] = [
      ...messageHistory.map((event) => ({
        role: event.payload.role as 'user' | 'assistant',
        content: event.payload.message,
      })),
      { role, content: message },
    ];

    await layers.WithAgentMemoryLayer.init();
    const memoryContext = formatMemoryContext(await layers.WithAgentMemoryLayer.loadSnapshot());
    const reactAgent = createAssistantReactAgent(tools.toTools(), {
      memoryContext,
    });

    const finalResponse = await streamReactAgentReply({
      agent: reactAgent,
      messages: chatMessages,
      tracing,
      onToken: (chunk) =>
        emit(
          MessageStreamChunkEvent.make({
            chunk,
            isFinal: false,
            role: 'assistant',
          }),
        ),
    });

    emit(
      MessageStreamChunkEvent.make({
        chunk: '',
        isFinal: true,
        role: 'assistant',
      }),
    );
    emit(
      MessageEvent.make({
        message: finalResponse,
        role: 'assistant',
      }),
    );
  })
  .produce({});
