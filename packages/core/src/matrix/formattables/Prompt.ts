import { BaseMessage } from '../Message';

// ========================
// PROMPT TYPES
// ========================

export class ChatPrompt {
  private formatSpecifier: Record<string, string> = {};

  constructor(
    public messages: BaseMessage[],
    public options: Record<string, unknown> = {}
  ) {}

  format(): string {
    const formattedMessages = this.messages.map((message) => {
      return message.toString();
    });

    return this.formatSpecifier.reduce((acc, [key, value]) => {
      return acc.replace(`{${key}}`, value);
    }, formattedMessages.join('\n'));
  }
}

export class SimplePrompt {
  constructor(public text: string) {}

  format(): string {
    return this.text;
  }
}

/*
type PromptOptions = {
  // In the future we could make {} specifier modifiable
};
*/

export class Prompt {
  static chat(messages: BaseMessage[]): ChatPrompt {
    return new ChatPrompt(messages);
  }

  static simple(text: string): SimplePrompt {
    return new SimplePrompt(text);
  }
}
