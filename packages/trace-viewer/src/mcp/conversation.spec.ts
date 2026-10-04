import { describe, expect, it } from 'vitest';
import { extractMessageSequences, formatMessages, normalizeMessage } from './conversation';

describe('normalizeMessage', () => {
  it('handles OpenAI messages with function tool calls', () => {
    expect(
      normalizeMessage({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
      }),
    ).toEqual({
      role: 'assistant',
      text: '',
      toolCalls: [{ name: 'search', args: { q: 'x' }, id: 'c1' }],
    });
  });

  it('handles LangChain serialized constructor messages', () => {
    expect(
      normalizeMessage({
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'ToolMessage'],
        kwargs: { content: 'done', tool_call_id: 'c1', name: 'search' },
      }),
    ).toEqual({ role: 'tool', name: 'search', text: 'done', toolCalls: [], toolCallId: 'c1' });
  });

  it('handles Anthropic content blocks', () => {
    const message = normalizeMessage({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: [{ type: 'text', text: 'boom' }],
          is_error: true,
        },
        { type: 'image', source: {} },
      ],
    });
    expect(message).toEqual({
      role: 'user',
      text: '[tool_result error] boom\n[image]',
      toolCalls: [],
      toolCallId: 'tu1',
    });
  });

  it('handles LangChain dict messages and rejects non-messages', () => {
    expect(normalizeMessage({ type: 'human', content: 'hi' })?.role).toBe('user');
    expect(normalizeMessage({ type: 'text', text: 'hi' })).toBeNull();
    expect(normalizeMessage('hi')).toBeNull();
  });
});

describe('extractMessageSequences', () => {
  it('finds nested chat-model inputs and standalone generation messages', () => {
    const input = {
      messages: [
        [
          { type: 'system', content: 'sys' },
          { type: 'human', content: 'q' },
        ],
      ],
    };
    expect(
      extractMessageSequences(input).map((sequence) => [sequence.path, sequence.messages.length]),
    ).toEqual([['$.messages[0]', 2]]);

    const output = { generations: [[{ text: 'a', message: { role: 'assistant', content: 'a' } }]] };
    expect(extractMessageSequences(output).map((sequence) => sequence.path)).toEqual([
      '$.generations[0][0].message',
    ]);
  });

  it('returns nothing for payloads without messages', () => {
    expect(extractMessageSequences({ results: [{ title: 'x' }] })).toEqual([]);
  });
});

describe('formatMessages', () => {
  it('renders roles, tool calls and truncates long content', () => {
    const text = formatMessages(
      [
        { role: 'user', text: 'x'.repeat(50), toolCalls: [] },
        { role: 'assistant', text: '', toolCalls: [{ name: 'search', args: { q: 1 }, id: 'c1' }] },
      ],
      { maxCharsPerMessage: 10 },
    );
    expect(text).toBe(
      `#0 user: ${'x'.repeat(9)}…\n#1 assistant: \n   ↳ tool_call search id=c1 {"q":1}`,
    );
  });
});
