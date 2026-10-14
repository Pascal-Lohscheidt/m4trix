import { isAbsolute, relative, resolve } from 'node:path';
import { DependencyLayer, S } from '@m4trix/core';

// ---------------------------------------------------------------------------------------------
// Workspace: the directory the agent works in. Every path a tool touches is resolved against it.
// ---------------------------------------------------------------------------------------------

export type WorkspaceApi = {
  readonly root: string;
  /** Absolute path for a workspace-relative (or absolute, inside the root) path. */
  resolve(path: string): string;
  /** Workspace-relative path for display. */
  relative(path: string): string;
};

export const Workspace = DependencyLayer.of({
  name: 'Workspace',
  config: S.Struct({ root: S.String }),
}).define<WorkspaceApi>();

export function createWorkspace(root: string) {
  const absoluteRoot = resolve(root);
  return Workspace.make({
    config: { root: absoluteRoot },
    root: absoluteRoot,
    resolve(path) {
      const target = resolve(absoluteRoot, path);
      const rel = relative(absoluteRoot, target);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Path "${path}" is outside the workspace (${absoluteRoot})`);
      }
      return target;
    },
    relative(path) {
      return relative(absoluteRoot, resolve(absoluteRoot, path)) || '.';
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Model: one chat completion with tools, streamed. OpenAI's Chat Completions API over fetch;
// swap the implementation for any provider, the agents only see `ModelApi`.
// ---------------------------------------------------------------------------------------------

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ModelTool = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

export type ModelResponse = {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export type ModelApi = {
  readonly model: string;
  complete(request: {
    messages: ChatMessage[];
    tools: ModelTool[];
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<ModelResponse>;
};

export const Model = DependencyLayer.of({
  name: 'Model',
  config: S.Struct({ model: S.String }),
}).define<ModelApi>();

type CompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
};

export function createOpenAIModel(options: { apiKey: string; model: string; baseUrl?: string }) {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  return Model.make({
    config: { model: options.model },
    model: options.model,
    async complete({ messages, tools, signal, onText }) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          // The API rejects an empty tools array (the compactor calls the model without tools).
          ...(tools.length > 0 ? { tools } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
      }

      let text = '';
      const calls: Array<{ id: string; name: string; arguments: string }> = [];
      let usage: ModelResponse['usage'];

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;

          const chunk = JSON.parse(data) as CompletionChunk;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            onText(delta.content);
          }
          for (const call of delta?.tool_calls ?? []) {
            calls[call.index] ??= { id: '', name: '', arguments: '' };
            const target = calls[call.index];
            if (call.id) target.id = call.id;
            if (call.function?.name) target.name += call.function.name;
            if (call.function?.arguments) target.arguments += call.function.arguments;
          }
        }
      }

      return { text, toolCalls: calls.filter(Boolean), usage };
    },
  });
}
