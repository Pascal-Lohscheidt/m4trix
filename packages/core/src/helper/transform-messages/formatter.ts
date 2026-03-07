import { AIMessage, BaseMessage } from '@langchain/core/messages';

// Format types
export enum FormatType {
  Concise = 'concise',
  Verbose = 'verbose',
  RedactAi = 'redact-ai',
  RedactHuman = 'redact-human',
  JSON = 'json',
}

/**
 * Formats messages in a concise markdown format with alternating AI and Human prefixes.
 *
 * ### Example
 * ```markdown
 * AI: Hello, how are you?
 * Human: I am good, thank you!
 * AI: What is your name?
 * Human: My name is John.
 * AI: What is your favorite color?
 * Human: My favorite color is blue.
 * AI: What is your favorite food?
 * Human: My favorite food is pizza.
 * ```
 */
function concise(messages: Array<BaseMessage>): string {
  return messages
    .map((message) => {
      const prefix = message instanceof AIMessage ? 'AI' : 'Human';
      return `${prefix}: ${message.content}`;
    })
    .join('\n');
}

/**
 * Formats messages in a verbose markdown format with alternating AI and Human prefixes.
 *
 * ### Example
 * ```markdown
 * AI:
 * Hello, how are you?
 * -------------------
 * Human:
 * I am good, thank you!
 * -------------------
 * AI:
 * What is your name?
 * -------------------
 * Human:
 * My name is John.
 * ```
 */
function verbose(messages: Array<BaseMessage>): string {
  return messages
    .map((message) => {
      const prefix = message instanceof AIMessage ? 'AI' : 'Human';
      return `${prefix}:\n${message.content}`;
    })
    .join('\n-------------------\n');
}

/**
 * Formats messages in a concise markdown format, redacting AI messages with [...]
 *
 * ### Example
 * ```markdown
 * AI: [...]
 * Human: Hello, how are you?
 * AI: [...]
 * Human: I am good, thank you!
 * AI: [...]
 * Human: What is your name?
 * AI: [...]
 * Human: My name is John.
 * AI: [...]
 * ```
 */
function redactAi(messages: Array<BaseMessage>): string {
  return messages
    .map((message) => {
      const prefix = message instanceof AIMessage ? 'AI' : 'Human';
      const content = message instanceof AIMessage ? '[...]' : message.content;
      return `${prefix}: ${content}`;
    })
    .join('\n');
}

/**
 * Formats messages in a concise markdown format, redacting Human messages with [...]
 *
 * ### Example
 * ```markdown
 * AI: Hello, how are you?
 * Human: [...]
 * AI: What is your name?
 * Human: [...]
 * AI: What is your favorite color?
 * Human: [...]
 * AI: What is your favorite food?
 * Human: [...]
 * ```
 */
function redactHuman(messages: Array<BaseMessage>): string {
  return messages
    .map((message) => {
      const prefix = message instanceof AIMessage ? 'AI' : 'Human';
      const content = message instanceof AIMessage ? '[...]' : message.content;
      return `${prefix}: ${content}`;
    })
    .join('\n');
}
const typeOnFormatter = {
  [FormatType.Concise]: concise,
  [FormatType.Verbose]: verbose,
  [FormatType.RedactAi]: redactAi,
  [FormatType.RedactHuman]: redactHuman,
};

export { typeOnFormatter };
