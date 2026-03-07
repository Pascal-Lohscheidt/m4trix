import { LLMResponse } from './LLM';

type MessageContent = string;

// ========================
// MESSAGE TYPES
// ========================

export abstract class BaseMessage {
  abstract role: string;
  abstract content: string;

  constructor(public metadata: Record<string, unknown> = {}) {}

  abstract toString(): string;
}

export class SystemMessage extends BaseMessage {
  role = 'system';

  constructor(
    public content: MessageContent,
    metadata: Record<string, unknown> = {}
  ) {
    super(metadata);
  }

  static fromText(text: string): SystemMessage {
    return new SystemMessage(text);
  }

  static fromFormat(
    template: string,
    variables: Record<string, unknown>
  ): SystemMessage {
    const formatted = template.replace(/\{(\w+)\}/g, (match, key) => {
      return String(variables[key] ?? match);
    });
    return new SystemMessage(formatted);
  }

  toString(): string {
    return this.content.toString();
  }
}

export class HumanMessage extends BaseMessage {
  role = 'user';

  constructor(
    public content: MessageContent,
    metadata: Record<string, unknown> = {}
  ) {
    super(metadata);
  }

  static fromText(text: string): HumanMessage {
    return new HumanMessage(text);
  }

  toString(): string {
    return this.content.toString();
  }
}

export class AssistantMessage extends BaseMessage {
  role = 'assistant';

  constructor(
    public content: MessageContent,
    metadata: Record<string, unknown> = {}
  ) {
    super(metadata);
  }

  static fromText(text: string): AssistantMessage {
    return new AssistantMessage(text);
  }

  static fromResponse(response: LLMResponse): AssistantMessage {
    return new AssistantMessage(response.content, {
      model: response.model,
      usage: response.usage,
      finishReason: response.finishReason,
    });
  }

  toString(): string {
    return this.content.toString();
  }
}
