import type { BoundTool } from '@m4trix/core';
import type { RunTraceScope } from '@m4trix/core/matrix';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';

import { langChainStreamConfig } from './tracing-bridge.js';
import { toLangChainTools } from './m4trix-tool-bridge.js';

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

const TOOL_SYSTEM_PROMPT = `You are a helpful assistant with access to web, filesystem, and memory tools.

- Use webSearch when you need up-to-date information or facts from the web.
- Use readWebPage when you have specific URLs and need fuller page content than search snippets.
- Prefer webSearch first; use readWebPage on URLs returned by search when snippets are insufficient.
- Use filesystem tools when the user asks you to inspect or edit local files.
- Use memory tools to persist long-lived preferences, notes, and sub-agent definitions.
- Use spawnSubAgent for complex multi-step work that benefits from an isolated background run (up to one minute).
- Use runCommand only when a shell command is truly needed; call the tool directly—the CLI approval prompt is handled by the tool, not by you asking the user first.
- Cite sources (title and URL) when using web results.`;

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type ContentBlock = {
  type: string;
  text?: string;
};

type StreamToken = {
  contentBlocks?: ContentBlock[];
};

function extractTextDelta(token: StreamToken): string {
  if (!token.contentBlocks) {
    return '';
  }

  return token.contentBlocks
    .filter((block): block is ContentBlock & { text: string } => block.type === 'text' && !!block.text)
    .map((block) => block.text)
    .join('');
}

function withMemoryContext(systemPrompt: string, memoryContext?: string): string {
  const trimmed = memoryContext?.trim();
  if (!trimmed) {
    return systemPrompt;
  }

  return `${systemPrompt}

## Persisted Agent Memory
${trimmed}`;
}

export function createAssistantReactAgent(
  boundTools: readonly BoundTool[],
  options?: { memoryContext?: string },
) {
  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? 'gpt-5.4',
    apiKey: process.env.OPENAI_API_KEY,
    streaming: true,
  });

  const langchainTools = toLangChainTools(boundTools);

  return createAgent({
    model,
    tools: langchainTools,
    systemPrompt: withMemoryContext(
      langchainTools.length > 0 ? TOOL_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT,
      options?.memoryContext,
    ),
  });
}

/** Stream final assistant text tokens from a ReAct agent run. */
export async function streamReactAgentReply(options: {
  agent: ReturnType<typeof createAssistantReactAgent>;
  messages: ChatMessage[];
  onToken: (chunk: string) => void;
  tracing: RunTraceScope;
}): Promise<string> {
  let response = '';

  const stream = await options.agent.stream(
    { messages: options.messages },
    {
      ...langChainStreamConfig(options.tracing),
      streamMode: 'messages',
    },
  );

  try {
    for await (const [token, metadata] of stream) {
      if (metadata && typeof metadata === 'object' && 'langgraph_node' in metadata) {
        const node = (metadata as { langgraph_node?: string }).langgraph_node;
        if (node === 'tools') {
          continue;
        }
      }

      const delta = extractTextDelta(token as StreamToken);
      if (!delta) {
        continue;
      }

      response += delta;
      options.onToken(delta);
    }

    return response;
  } finally {
    await options.tracing.flush();
  }
}
