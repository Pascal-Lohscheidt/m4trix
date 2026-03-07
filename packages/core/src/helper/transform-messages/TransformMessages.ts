import { BaseMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { Effect, pipe } from 'effect';
import {
  MessageFilter,
  MessageFilterType,
  typeOnFilter,
} from './message-filter';
import { FormatType, typeOnFormatter } from './formatter';

/**
 * # Transform Messages
 * In order to manage the context size often you want to slice messages or only pass certain types of messages.
 * This class is a helper to do that.
 *
 * ## Example
 * ```ts
 * const messages = [
 *   new HumanMessage('Hello, how are you?'),
 *   new AIMessage('I am good, thank you!'),
 * ];
 *
 * const transformedMessages = TransformMessages.from(messages).filter(HumanAndAI).last(10).format(FormatType.Concise);
 *
 * ```
 */

class TransformMessages {
  private effect: Effect.Effect<Array<BaseMessage>, never, never>;

  private constructor(effect: Effect.Effect<Array<BaseMessage>, never, never>) {
    this.effect = effect;
  }

  /**
   * Create a new TransformMessages from an array of messages.
   */
  static from(messages: Array<BaseMessage>): TransformMessages {
    return new TransformMessages(Effect.succeed(messages));
  }

  /**
   * Filter messages based on a predicate function
   */
  filter(
    predicate: MessageFilter | MessageFilterType,
    tags?: Array<string>
  ): TransformMessages {
    let finalPredicate: MessageFilter;
    if (typeof predicate === 'string') {
      finalPredicate = typeOnFilter[predicate];
    } else {
      finalPredicate = predicate;
    }

    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) =>
          messages.filter((message) => finalPredicate(message, tags))
        )
      )
    );
  }

  /**
   * Take only the last n messages, but safely.
   * Tool calls should not be separated from the last human message.
   * Ensures all tool call conversations in the last n messages are complete.
   */
  safelyTakeLast(
    n: number,
    pruneAfterNOvershootingMessages: number = 0
  ): TransformMessages {
    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) => {
          const total = messages.length;
          if (n <= 0 || total === 0) return [];

          // Start with the last n messages
          const start = Math.max(0, total - n);
          const end = total;
          const lastSlice = messages.slice(start, end);

          // due to the fact that the calling AI message needs to be adjecent to the succeeding tool call message
          // we just need to check the last n messages for tool call ids

          // Check the first message if it is a tool call message
          // if it is iterate backwards until we find the AI message
          if (
            lastSlice[0] instanceof ToolMessage &&
            lastSlice[0].tool_call_id
          ) {
            let messagesToInclude: Array<BaseMessage> = [];
            const remainingMessages = messages.slice(0, start);
            for (let i = remainingMessages.length - 1; i >= 0; i--) {
              const msg = remainingMessages[i];
              if (
                pruneAfterNOvershootingMessages > 0 &&
                messagesToInclude.length - 1 >= pruneAfterNOvershootingMessages
              ) {
                messagesToInclude = [];
                // Return the slice but remove all the tool call messages that are at the beginning of the slice
                const filteredSlice: Array<BaseMessage> = [];
                let foundFirstNonToolMessage = false;
                for (let i = 0; i < lastSlice.length; i++) {
                  const msg = lastSlice[i];
                  if (msg instanceof ToolMessage) {
                    if (foundFirstNonToolMessage) {
                      filteredSlice.push(msg);
                    }
                  } else {
                    foundFirstNonToolMessage = true;
                    filteredSlice.push(msg);
                  }
                }
                return filteredSlice;
              }
              if (msg instanceof AIMessage && Array.isArray(msg.tool_calls)) {
                messagesToInclude.push(msg);
                break;
              } else if (msg instanceof ToolMessage) {
                messagesToInclude.push(msg);
              } else {
                // This should not happen messages invalid
                throw new Error(
                  'Messages array invalid no adjacent AI message found'
                );
              }
            }
            return [...messagesToInclude.reverse(), ...lastSlice];
          } else {
            return lastSlice;
          }
        })
      )
    );
  }

  /**
   * Take only the last n messages
   */
  last(n: number): TransformMessages {
    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) => messages.slice(-n))
      )
    );
  }

  /**
   * Take only the first n messages
   */
  first(n: number): TransformMessages {
    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) => messages.slice(0, n))
      )
    );
  }

  /**
   * Skip the first n messages
   */
  skip(n: number): TransformMessages {
    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) => messages.slice(n))
      )
    );
  }

  /**
   * Reverse the order of messages
   */
  reverse(): TransformMessages {
    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) => [...messages].reverse())
      )
    );
  }

  /**
   * Map over messages with a transformation function
   */
  map<T extends BaseMessage>(
    fn: (message: BaseMessage) => T
  ): TransformMessages {
    return new TransformMessages(
      pipe(
        this.effect,
        Effect.map((messages) => messages.map(fn))
      )
    );
  }

  /**
   * Format messages according to the specified format type
   */
  format(formatType: FormatType): string {
    const result = Effect.runSync(
      pipe(
        this.effect,
        Effect.map((messages) => {
          if (formatType === FormatType.JSON) {
            return JSON.stringify(messages, null, 2);
          }
          const formatter = typeOnFormatter[formatType];
          return formatter(messages);
        })
      )
    );
    return result;
  }

  // Sink methods

  /**
   * Convert to array - runs the effect and returns the result
    return pipe(
      this.effect,
      Effect.map((messages) => {
        if (formatType === FormatType.JSON) {
          return JSON.stringify(messages, null, 2);
        }

        const formatter = typeOnFormatter[formatType];
        return formatter(messages);
      })
    );
  }

  // Sink methods

  /**
   * Convert to array - runs the effect and returns the result
   */
  toArray(): Array<BaseMessage> {
    return Effect.runSync(this.effect);
  }

  /**
   * Convert to string - runs the effect and returns JSON string
   */
  toString(): string {
    const result = Effect.runSync(
      pipe(
        this.effect,
        Effect.map((messages) => JSON.stringify(messages, null, 2))
      )
    );
    return result;
  }

  /**
   * Get the count of messages
   */
  count(): number {
    const result = Effect.runSync(
      pipe(
        this.effect,
        Effect.map((messages) => messages.length)
      )
    );
    return result;
  }
}

export { TransformMessages };
