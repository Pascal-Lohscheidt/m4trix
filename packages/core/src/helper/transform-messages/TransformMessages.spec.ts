import { describe, it, expect } from 'vitest';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { TransformMessages } from './TransformMessages';
import { FormatType } from './formatter';
import { MessageFilterType } from './message-filter';

describe('TransformMessages', () => {
  const messages = [
    new HumanMessage('Hello'),
    new AIMessage('Hi there!'),
    new ToolMessage('tool1', 'result1'),
    new HumanMessage('How are you?'),
    new AIMessage('I am good!'),
  ];

  it('should create from messages', async () => {
    const result = TransformMessages.from(messages).toArray();
    expect(result).toEqual(messages);
  });

  it('should filter Human and AI messages', async () => {
    const result = TransformMessages.from(messages)
      .filter(MessageFilterType.HumanAndAI)
      .toArray();
    expect(result).toHaveLength(4);
    expect(
      result.every(
        (msg) => msg instanceof HumanMessage || msg instanceof AIMessage
      )
    ).toBe(true);
  });

  it('should filter only Human messages', async () => {
    const result = TransformMessages.from(messages)
      .filter(MessageFilterType.HumanOnly)
      .toArray();
    expect(result).toHaveLength(2);
    expect(result.every((msg) => msg instanceof HumanMessage)).toBe(true);
  });

  it('should filter only AI messages', async () => {
    const result = TransformMessages.from(messages)
      .filter(MessageFilterType.AIOnly)
      .toArray();
    expect(result).toHaveLength(2);
    expect(result.every((msg) => msg instanceof AIMessage)).toBe(true);
  });

  it('should take last n messages', async () => {
    const result = TransformMessages.from(messages).last(2).toArray();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(messages[3]); // 'How are you?'
    expect(result[1]).toEqual(messages[4]); // 'I am good!'
  });

  it('should take first n messages', async () => {
    const result = TransformMessages.from(messages).first(2).toArray();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(messages[0]); // 'Hello'
    expect(result[1]).toEqual(messages[1]); // 'Hi there!'
  });

  it('should skip first n messages', async () => {
    const result = TransformMessages.from(messages).skip(2).toArray();
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(messages[2]); // ToolMessage
    expect(result[1]).toEqual(messages[3]); // 'How are you?'
    expect(result[2]).toEqual(messages[4]); // 'I am good!'
  });

  it('should reverse messages', async () => {
    const result = TransformMessages.from(messages).reverse().toArray();
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(messages[4]); // Last message first
    expect(result[4]).toEqual(messages[0]); // First message last
  });

  it('should count messages', async () => {
    const count = TransformMessages.from(messages)
      .filter(MessageFilterType.HumanOnly)
      .count();
    expect(count).toBe(2);
  });

  it('should format messages as concise', async () => {
    const testMessages = messages.slice(0, 2);
    const result = TransformMessages.from(testMessages).format(
      FormatType.Concise
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Human: Hello');
    expect(result as string).toContain('AI: Hi there!');
  });

  it('should format messages as JSON', async () => {
    const testMessages = messages.slice(0, 2);
    const jsonStr = TransformMessages.from(testMessages).format(
      FormatType.JSON
    );
    const parsed = JSON.parse(jsonStr as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].kwargs.content).toBe('Hello');
    expect(parsed[1].kwargs.content).toBe('Hi there!');
  });

  it('should format messages as verbose', async () => {
    const testMessages = messages.slice(0, 2);
    const result = TransformMessages.from(testMessages).format(
      FormatType.Verbose
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('Human:\nHello');
    expect(result as string).toContain('AI:\nHi there!');
  });

  it('should format messages as redact-ai', async () => {
    const testMessages = messages.slice(0, 2);
    const result = TransformMessages.from(testMessages).format(
      FormatType.RedactAi
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('AI: [...]');
  });

  it('should format messages as redact-human', async () => {
    const testMessages = messages.slice(0, 2);
    const result = TransformMessages.from(testMessages).format(
      FormatType.RedactHuman
    );
    expect(typeof result).toBe('string');
    expect(result as string).toContain('AI: [...]');
  });

  it('should work with all format types in a chain', async () => {
    const testMessages = [
      new HumanMessage('What is the weather?'),
      new AIMessage('Let me check the weather for you.'),
      new HumanMessage('Thanks!'),
      new AIMessage('You are welcome!'),
    ];

    // Test each format type
    const formatTypes = [
      FormatType.Concise,
      FormatType.Verbose,
      FormatType.RedactAi,
      FormatType.RedactHuman,
      FormatType.JSON,
    ];

    for (const formatType of formatTypes) {
      const output = TransformMessages.from(testMessages)
        .filter(MessageFilterType.HumanAndAI)
        .format(formatType);

      expect(typeof output).toBe('string');

      if (formatType === FormatType.JSON) {
        const parsed = JSON.parse(output as string);
        expect(parsed.length).toBe(4);
        expect(parsed[0].kwargs.content).toBe('What is the weather?');
      } else {
        expect((output as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('should chain multiple operations', async () => {
    const result = TransformMessages.from(messages)
      .filter(MessageFilterType.HumanAndAI)
      .skip(1)
      .last(2)
      .toArray();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(messages[3]); // 'How are you?'
    expect(result[1]).toEqual(messages[4]); // 'I am good!'
  });

  describe('safelyTakeLast', () => {
    it('should take last n messages when no tool messages are present', async () => {
      const simpleMessages = [
        new HumanMessage('Hello'),
        new AIMessage('Hi there!'),
        new HumanMessage('How are you?'),
        new AIMessage('I am good!'),
      ];

      const result = TransformMessages.from(simpleMessages)
        .safelyTakeLast(2)
        .toArray();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(simpleMessages[2]); // 'How are you?'
      expect(result[1]).toEqual(simpleMessages[3]); // 'I am good!'
    });

    it('should handle the case where first message in last slice is a ToolMessage', async () => {
      // Create messages where the last slice starts with a ToolMessage
      const messagesWithToolCall = [
        new HumanMessage('What is the weather?'),
        new AIMessage('Let me check the weather for you.', {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        }),
        new ToolMessage('call_1', 'The weather is sunny'),
        new HumanMessage('Thanks!'),
        new AIMessage('You are welcome!'),
      ];

      // Taking last 3 messages should include the ToolMessage as the first message in the slice
      const result = TransformMessages.from(messagesWithToolCall)
        .safelyTakeLast(3)
        .toArray();
      // Should include the AI message with tool call, ToolMessage, and the last 3 messages
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual(messagesWithToolCall[1]); // AI message with tool call
      expect(result[1]).toEqual(messagesWithToolCall[2]); // ToolMessage
      expect(result[2]).toEqual(messagesWithToolCall[3]); // 'Thanks!'
      expect(result[3]).toEqual(messagesWithToolCall[4]); // 'You are welcome!'
    });

    it('should handle multiple tool calls in a single AI message', async () => {
      const multiToolMessages = [
        new HumanMessage('Get me weather and time'),
        new AIMessage('I will get both for you.', {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'get_time', arguments: '{}' },
            },
          ],
        }),
        new ToolMessage('call_1', 'Weather is sunny'),
        new ToolMessage('call_2', 'Time is 3:00 PM'),
        new HumanMessage('Perfect!'),
        new AIMessage('Glad I could help!'),
      ];

      const result = TransformMessages.from(multiToolMessages)
        .safelyTakeLast(3)
        .toArray();
      // Should include the AI message with both tool calls, both ToolMessages, and the last 3 messages
      expect(result).toHaveLength(5);
      expect(result[0]).toEqual(multiToolMessages[1]); // AI message with tool calls
      expect(result[1]).toEqual(multiToolMessages[2]); // First ToolMessage
      expect(result[2]).toEqual(multiToolMessages[3]); // Second ToolMessage
      expect(result[3]).toEqual(multiToolMessages[4]); // 'Perfect!'
      expect(result[4]).toEqual(multiToolMessages[5]); // 'Glad I could help!'
    });

    it('should search backwards to find the corresponding AI message', async () => {
      const messagesWithGap = [
        new HumanMessage('Start conversation'),
        new AIMessage('Initial response'),
        new HumanMessage('Get weather'),
        new AIMessage('Let me check.', {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        }),
        new ToolMessage('call_1', 'Weather is rainy'),
        new HumanMessage('Thanks'),
        new AIMessage('You are welcome'),
      ];

      const result = TransformMessages.from(messagesWithGap)
        .safelyTakeLast(3)
        .toArray();
      // Should include the AI message with tool call, ToolMessage, and the last 3 messages
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual(messagesWithGap[3]); // AI message with tool call
      expect(result[1]).toEqual(messagesWithGap[4]); // ToolMessage
      expect(result[2]).toEqual(messagesWithGap[5]); // 'Thanks'
      expect(result[3]).toEqual(messagesWithGap[6]); // 'You are welcome'
    });

    it('should respect the pruneAfterNOvershootingMessages parameter', async () => {
      const messagesWithManyToolCalls = [
        new HumanMessage('Start'),
        new AIMessage('First tool call', {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'tool1', arguments: '{}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'tool2', arguments: '{}' },
            },
            {
              id: 'call_3',
              type: 'function',
              function: { name: 'tool3', arguments: '{}' },
            },
            {
              id: 'call_4',
              type: 'function',
              function: { name: 'tool4', arguments: '{}' },
            },
          ],
        }),
        new ToolMessage('call_1', 'result1'),
        new ToolMessage('call_2', 'result2'),
        new ToolMessage('call_3', 'result3'),
        new ToolMessage('call_4', 'result4'),
        new HumanMessage('Thanks'),
        new AIMessage('You are welcome'),
      ];

      // With pruneAfterNOvershootingMessages = 1, it should stop searching after 1 message
      const result = TransformMessages.from(messagesWithManyToolCalls)
        .safelyTakeLast(3, 2)
        .toArray();
      // Should only include the last 2 messages since pruning stops the search
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 2]
      ); // 'Thanks'
      expect(result[1]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 1]
      ); // 'You are welcome'
    });

    it('should not destroy order of messages', async () => {
      const messagesWithManyToolCalls = [
        new HumanMessage('Start'),
        new AIMessage('First tool call', {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'tool1', arguments: '{}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'tool2', arguments: '{}' },
            },
            {
              id: 'call_3',
              type: 'function',
              function: { name: 'tool3', arguments: '{}' },
            },
          ],
        }),
        new ToolMessage('call_1', 'result1'),
        new ToolMessage('call_2', 'result2'),
        new ToolMessage('call_3', 'result3'),
        new AIMessage('You are welcome'),
      ];

      // With pruneAfterNOvershootingMessages = 1, it should stop searching after 1 message
      const result = TransformMessages.from(messagesWithManyToolCalls)
        .safelyTakeLast(2)
        .toArray();
      // Should only include the last 2 messages since pruning stops the search
      expect(result).toHaveLength(5);
      expect(result[0]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 5]
      ); // 'Start'
      expect(result[1]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 4]
      ); // 'First tool call'
      expect(result[2]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 3]
      ); // 'result1'
      expect(result[3]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 2]
      ); // 'Second request'
      expect(result[4]).toEqual(
        messagesWithManyToolCalls[messagesWithManyToolCalls.length - 1]
      ); // 'You are welcome'
    });

    it('should work with chained operations', async () => {
      const chainedMessages = [
        new HumanMessage('Hello'),
        new AIMessage('Hi!'),
        new ToolMessage('tool1', 'result1'),
        new HumanMessage('How are you?'),
        new AIMessage('I am good!'),
      ];

      const result = TransformMessages.from(chainedMessages)
        .filter(MessageFilterType.HumanAndAI)
        .safelyTakeLast(2)
        .toArray();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(chainedMessages[3]); // 'How are you?'
      expect(result[1]).toEqual(chainedMessages[4]); // 'I am good!'
    });

    it('should handle empty tool call arrays gracefully', async () => {
      const emptyToolCallsMessages = [
        new HumanMessage('Hello'),
        new AIMessage('Hi there!', {
          tool_calls: [], // Empty tool calls array
        }),
        new HumanMessage('How are you?'),
        new AIMessage('I am good!'),
      ];

      const result = TransformMessages.from(emptyToolCallsMessages)
        .safelyTakeLast(2)
        .toArray();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(emptyToolCallsMessages[2]); // 'How are you?'
      expect(result[1]).toEqual(emptyToolCallsMessages[3]); // 'I am good!'
    });

    it('should return normal slice when ToolMessage is not the first message in the slice', async () => {
      const messagesWithToolCall = [
        new HumanMessage('What is the weather?'),
        new AIMessage('Let me check the weather for you.', {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{}' },
            },
          ],
        }),
        new ToolMessage('call_1', 'The weather is sunny'),
        new HumanMessage('Thanks!'),
        new AIMessage('You are welcome!'),
      ];

      // Taking last 2 messages - ToolMessage is not the first in the slice
      const result = TransformMessages.from(messagesWithToolCall)
        .safelyTakeLast(2)
        .toArray();
      // Should just return the last 2 messages normally
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(messagesWithToolCall[3]); // 'Thanks!'
      expect(result[1]).toEqual(messagesWithToolCall[4]); // 'You are welcome!'
    });

    it.skip('should throw error when no adjacent AI message is found', async () => {
      const invalidMessages = [
        new HumanMessage('Hello'),
        new ToolMessage('call_1', 'result1'), // ToolMessage without preceding AI message
        new HumanMessage('How are you?'),
        new AIMessage('I am good!'),
      ];

      await expect(
        TransformMessages.from(invalidMessages).safelyTakeLast(2).toArray()
      ).rejects.toThrow('Messages array invalid no adjacent AI message found');
    });
  });

  it('should filter messages including specific tags', async () => {
    const taggedMessages = [
      new HumanMessage('Hello', { tags: ['greeting', 'start'] }),
      new AIMessage('Hi there!', { tags: ['response'] }),
      new HumanMessage('How are you?', { tags: ['question'] }),
      new AIMessage('I am good!', { tags: ['response', 'positive'] }),
    ];

    const result = TransformMessages.from(taggedMessages)
      .filter(MessageFilterType.IncludingTags, ['greeting'])
      .toArray();
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello');
  });

  it('should filter messages excluding specific tags', async () => {
    const taggedMessages = [
      new HumanMessage('Hello', { tags: ['greeting', 'start'] }),
      new AIMessage('Hi there!', { tags: ['response'] }),
      new HumanMessage('How are you?', { tags: ['question'] }),
      new AIMessage('I am good!', { tags: ['response', 'positive'] }),
    ];

    const result = TransformMessages.from(taggedMessages)
      .filter(MessageFilterType.ExcludingTags, ['response'])
      .toArray();
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('How are you?');
  });

  it('should filter messages with multiple tags', async () => {
    const taggedMessages = [
      new HumanMessage('Hello', { tags: ['greeting', 'start'] }),
      new AIMessage('Hi there!', { tags: ['response'] }),
      new HumanMessage('How are you?', { tags: ['question'] }),
      new AIMessage('I am good!', { tags: ['response', 'positive'] }),
    ];

    const result = TransformMessages.from(taggedMessages)
      .filter(MessageFilterType.IncludingTags, ['greeting', 'question'])
      .toArray();
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('How are you?');
  });

  it('should handle messages without tags gracefully', async () => {
    const mixedMessages = [
      new HumanMessage('Hello'),
      new AIMessage('Hi there!', { tags: ['response'] }),
      new HumanMessage('How are you?'),
      new AIMessage('I am good!', { tags: ['response', 'positive'] }),
    ];

    const result = TransformMessages.from(mixedMessages)
      .filter(MessageFilterType.IncludingTags, ['response'])
      .toArray();

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hi there!');
    expect(result[1].content).toBe('I am good!');
  });

  it('should handle empty tags array', async () => {
    const taggedMessages = [
      new HumanMessage('Hello', { tags: ['greeting'] }),
      new AIMessage('Hi there!', { tags: ['response'] }),
    ];

    const result = TransformMessages.from(taggedMessages)
      .filter(MessageFilterType.IncludingTags, [])
      .toArray();

    expect(result).toHaveLength(0);
  });

  it('should handle undefined tags parameter', async () => {
    const taggedMessages = [
      new HumanMessage('Hello', { tags: ['greeting'] }),
      new AIMessage('Hi there!', { tags: ['response'] }),
    ];

    const result = TransformMessages.from(taggedMessages)
      .filter(MessageFilterType.IncludingTags)
      .toArray();

    expect(result).toHaveLength(2); // Should include all messages when tags is undefined
  });
});
