import { appendIndex, appendKey, isRecord, oneLine, safeStringify, truncate } from './json-utils';

export type ToolCall = { name: string; args: unknown; id?: string };

export type NormalizedMessage = {
  role: string;
  name?: string;
  text: string;
  toolCalls: ToolCall[];
  toolCallId?: string;
};

export type MessageSequence = { path: string; messages: NormalizedMessage[] };

const LANGCHAIN_ROLE_BY_CLASS: Record<string, string> = {
  HumanMessage: 'user',
  AIMessage: 'assistant',
  SystemMessage: 'system',
  ToolMessage: 'tool',
  FunctionMessage: 'function',
  ChatMessage: 'chat',
};

const LANGCHAIN_ROLE_BY_TYPE: Record<string, string> = {
  human: 'user',
  ai: 'assistant',
  system: 'system',
  tool: 'tool',
  function: 'function',
  developer: 'developer',
};

const MAX_WALK_DEPTH = 8;

/**
 * Normalizes the common message shapes found in LLM payloads: OpenAI/Anthropic
 * `{ role, content }`, LangChain serialized constructors (`{ lc, type: 'constructor', id, kwargs }`)
 * and LangChain dict messages (`{ type: 'human' | 'ai' | …, content }`).
 */
export function normalizeMessage(value: unknown): NormalizedMessage | null {
  if (!isRecord(value)) return null;

  if (
    value.lc === 1 &&
    value.type === 'constructor' &&
    Array.isArray(value.id) &&
    isRecord(value.kwargs)
  ) {
    const className = String(value.id[value.id.length - 1] ?? '').replace(/Chunk$/, '');
    if (!className.endsWith('Message')) return null;
    const role =
      LANGCHAIN_ROLE_BY_CLASS[className] ??
      (typeof value.kwargs.role === 'string' ? value.kwargs.role : className);
    return fromFields(role, value.kwargs);
  }

  if (typeof value.role === 'string' && ('content' in value || 'tool_calls' in value)) {
    return fromFields(value.role, value);
  }

  if (typeof value.type === 'string' && LANGCHAIN_ROLE_BY_TYPE[value.type] && 'content' in value) {
    return fromFields(LANGCHAIN_ROLE_BY_TYPE[value.type], value);
  }

  return null;
}

function fromFields(role: string, fields: Record<string, unknown>): NormalizedMessage {
  const { text, toolCalls: contentToolCalls, toolResultIds } = renderContent(fields.content);
  const additional = isRecord(fields.additional_kwargs) ? fields.additional_kwargs : undefined;
  const toolCalls = [
    ...contentToolCalls,
    ...normalizeToolCalls(fields.tool_calls),
    ...(Array.isArray(fields.tool_calls) && fields.tool_calls.length > 0
      ? []
      : normalizeToolCalls(additional?.tool_calls)),
  ];
  const toolCallId =
    (typeof fields.tool_call_id === 'string' ? fields.tool_call_id : undefined) ?? toolResultIds[0];
  return {
    role,
    ...(typeof fields.name === 'string' && fields.name ? { name: fields.name } : {}),
    text,
    toolCalls,
    ...(toolCallId ? { toolCallId } : {}),
  };
}

function renderContent(content: unknown): {
  text: string;
  toolCalls: ToolCall[];
  toolResultIds: string[];
} {
  if (typeof content === 'string') return { text: content, toolCalls: [], toolResultIds: [] };
  if (!Array.isArray(content)) {
    return {
      text: content === undefined || content === null ? '' : safeStringify(content),
      toolCalls: [],
      toolResultIds: [],
    };
  }

  const parts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResultIds: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    switch (part.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        parts.push(String(part.text ?? ''));
        break;
      case 'thinking':
      case 'reasoning':
        parts.push(`[thinking] ${String(part.thinking ?? part.text ?? part.reasoning ?? '')}`);
        break;
      case 'tool_use':
        toolCalls.push({
          name: String(part.name ?? 'unknown'),
          args: part.input,
          ...(typeof part.id === 'string' ? { id: part.id } : {}),
        });
        break;
      case 'tool_result': {
        if (typeof part.tool_use_id === 'string') toolResultIds.push(part.tool_use_id);
        const inner = renderContent(part.content).text;
        parts.push(`${part.is_error ? '[tool_result error] ' : ''}${inner}`);
        break;
      }
      case 'image':
      case 'image_url':
      case 'input_image':
        parts.push('[image]');
        break;
      default:
        parts.push(safeStringify(part));
    }
  }
  return { text: parts.join('\n'), toolCalls, toolResultIds };
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((call) => {
    const fn = isRecord(call.function) ? call.function : undefined;
    const name = String(call.name ?? fn?.name ?? 'unknown');
    let args: unknown = call.args ?? call.input ?? fn?.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // keep raw string arguments
      }
    }
    return { name, args, ...(typeof call.id === 'string' ? { id: call.id } : {}) };
  });
}

/**
 * Finds message sequences anywhere in a payload: arrays whose items are mostly messages
 * (nested arrays such as chat-model `[[…messages]]` inputs included) and standalone
 * messages such as `generations[0][0].message`.
 */
export function extractMessageSequences(value: unknown): MessageSequence[] {
  const sequences: MessageSequence[] = [];

  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      const messages = node.map(normalizeMessage);
      const count = messages.filter(Boolean).length;
      if (count > 0 && count * 2 >= node.length) {
        sequences.push({
          path,
          messages: messages.filter((message): message is NormalizedMessage => message !== null),
        });
        return;
      }
      node.forEach((item, index) => {
        visit(item, appendIndex(path, index), depth + 1);
      });
      return;
    }

    const single = normalizeMessage(node);
    if (single) {
      sequences.push({ path, messages: [single] });
      return;
    }
    for (const [key, item] of Object.entries(node)) visit(item, appendKey(path, key), depth + 1);
  };

  visit(value, '$', 0);
  return sequences;
}

export function formatMessages(
  messages: NormalizedMessage[],
  options: { maxCharsPerMessage?: number } = {},
): string {
  const maxChars = options.maxCharsPerMessage ?? 2000;
  return messages
    .map((message, index) => {
      const head = [
        `#${index} ${message.role}`,
        message.name ? `(${message.name})` : '',
        message.toolCallId ? `[tool_call_id ${message.toolCallId}]` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const lines = [`${head}: ${truncate(message.text, maxChars)}`];
      for (const call of message.toolCalls) {
        const id = call.id ? ` id=${call.id}` : '';
        lines.push(
          `   ↳ tool_call ${call.name}${id} ${truncate(oneLine(safeStringify(call.args)), 400)}`,
        );
      }
      return lines.join('\n');
    })
    .join('\n');
}
