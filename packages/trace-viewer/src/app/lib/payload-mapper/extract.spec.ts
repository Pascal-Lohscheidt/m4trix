import { describe, expect, it } from 'vitest';
import { classifyRole, normalizeContent, normalizeToolCall, resolveView } from './extract';

describe('classifyRole', () => {
  it.each([
    ['human', 'user'],
    ['HumanMessage', 'user'],
    ['user', 'user'],
    ['ai', 'assistant'],
    ['AIMessageChunk', 'assistant'],
    ['assistant', 'assistant'],
    ['system', 'system'],
    ['developer', 'system'],
    ['tool', 'tool'],
    ['ToolMessage', 'tool'],
    ['chain', 'other'],
  ])('%s → %s', (role, expected) => {
    expect(classifyRole(role)).toBe(expected);
  });
});

describe('normalizeToolCall', () => {
  it('handles LangChain, Anthropic and OpenAI shapes', () => {
    expect(normalizeToolCall({ name: 'a', args: { q: 1 }, id: 'x' })).toEqual({
      name: 'a',
      args: { q: 1 },
      id: 'x',
    });
    expect(normalizeToolCall({ type: 'tool_use', name: 'b', input: { q: 2 }, id: 'y' })).toEqual({
      name: 'b',
      args: { q: 2 },
      id: 'y',
    });
    expect(normalizeToolCall({ id: 'z', function: { name: 'c', arguments: '{"q":3}' } })).toEqual({
      name: 'c',
      args: { q: 3 },
      id: 'z',
    });
  });

  it('keeps unparseable string args as strings', () => {
    expect(normalizeToolCall({ name: 'a', arguments: '{oops' }).args).toBe('{oops');
  });
});

describe('normalizeContent', () => {
  it('normalizes strings and content-block arrays', () => {
    expect(normalizeContent('hi')).toEqual([{ type: 'text', text: 'hi' }]);
    expect(normalizeContent('')).toEqual([]);
    expect(normalizeContent(null)).toEqual([]);
    expect(
      normalizeContent([
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', name: 't', input: {}, id: '1' },
        { type: 'tool_result', tool_use_id: '1', content: 'done', is_error: true },
        { type: 'image', source: {} },
        { type: 'custom', x: 1 },
      ]),
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'reasoning', text: 'hmm' },
      { type: 'toolCall', call: { name: 't', args: {}, id: '1' } },
      {
        type: 'toolResult',
        toolCallId: '1',
        isError: true,
        parts: [{ type: 'text', text: 'done' }],
      },
      { type: 'image', label: 'image' },
      { type: 'json', value: { type: 'custom', x: 1 } },
    ]);
  });
});

describe('resolveView', () => {
  const payload = {
    messages: [
      { type: 'system', content: 'be nice' },
      { type: 'human', content: 'weather?' },
      {
        type: 'ai',
        content: '',
        tool_calls: [{ name: 'weather', args: { city: 'Berlin' }, id: 'c1' }],
      },
    ],
    usage: { input_tokens: 10 },
  };

  it('resolves messages with tool calls and collapsed roles', () => {
    const { view, issues } = resolveView(
      {
        kind: 'messages',
        items: '$.messages[*]',
        role: '$.type',
        content: '$.content',
        toolCalls: { items: '$.tool_calls[*]' },
        collapseRoles: ['system'],
      },
      payload,
    );
    expect(issues).toEqual([]);
    expect(view.kind).toBe('messages');
    if (view.kind !== 'messages') return;
    expect(view.totalCount).toBe(3);
    expect(view.messages.map((m) => [m.roleClass, m.collapsed])).toEqual([
      ['system', true],
      ['user', false],
      ['assistant', false],
    ]);
    expect(view.messages[2].toolCalls).toEqual([
      { name: 'weather', args: { city: 'Berlin' }, id: 'c1' },
    ]);
  });

  it('falls back when the messages path is missing', () => {
    const { view, issues } = resolveView({ kind: 'messages', items: '$.nope[*]' }, payload);
    expect(view).toMatchObject({ kind: 'fallback', value: payload });
    expect(issues).toEqual(['messages.items: no match for $.nope[*]']);
  });

  it('records partial misses without failing the view', () => {
    const { view, issues } = resolveView(
      { kind: 'messages', items: '$.messages[*]', role: '$.role' },
      payload,
    );
    expect(view.kind).toBe('messages');
    if (view.kind === 'messages')
      expect(view.messages[1]).toMatchObject({ role: 'human', roleClass: 'user' });
    expect(issues).toEqual(['messages.role: no match for $.role']);
  });

  it('mixes configured paths with per-item fallbacks', () => {
    const { view } = resolveView(
      { kind: 'messages', items: '$[*]', role: '$.id[-1]', content: '$.kwargs.content' },
      [
        { role: 'user', content: 'plain' },
        {
          lc: 1,
          id: ['langchain_core', 'messages', 'AIMessage'],
          kwargs: { content: 'constructed' },
        },
      ],
    );
    if (view.kind !== 'messages') throw new Error('expected messages');
    expect(view.messages.map((m) => [m.role, m.parts])).toEqual([
      ['user', [{ type: 'text', text: 'plain' }]],
      ['AIMessage', [{ type: 'text', text: 'constructed' }]],
    ]);
  });

  it('rebases scope with `at` and resolves keyValue / code / table', () => {
    expect(
      resolveView(
        { kind: 'keyValue', at: '$.usage', entries: [{ label: 'In', value: '$.input_tokens' }] },
        payload,
      ).view,
    ).toEqual({ kind: 'keyValue', entries: [{ label: 'In', value: 10 }] });

    expect(resolveView({ kind: 'code', value: '$.usage' }, payload).view).toMatchObject({
      kind: 'code',
      language: 'json',
    });

    expect(
      resolveView(
        { kind: 'table', rows: '$.messages[*]', columns: [{ label: 'Type', value: '$.type' }] },
        payload,
      ).view,
    ).toEqual({
      kind: 'table',
      columns: ['Type'],
      rows: [['system'], ['human'], ['ai']],
      totalCount: 3,
    });
  });

  it('falls back for a missing `at` and for empty keyValue / markdown', () => {
    expect(resolveView({ kind: 'json', at: '$.nope' }, payload).view.kind).toBe('fallback');
    expect(
      resolveView({ kind: 'keyValue', entries: [{ label: 'x', value: '$.nope' }] }, payload).view
        .kind,
    ).toBe('fallback');
    expect(resolveView({ kind: 'markdown', value: '$.nope' }, payload).view.kind).toBe('fallback');
  });

  it('resolves toolResult content and nested body, and stack children', () => {
    const { view } = resolveView(
      {
        kind: 'stack',
        children: [
          { kind: 'toolResult', status: '$.status', content: '$.content' },
          { kind: 'toolResult', body: { kind: 'text', value: '$.content' } },
        ],
      },
      { status: 'ok', content: '[{"type":"text","text":"sunny"}]' },
    );
    expect(view).toEqual({
      kind: 'stack',
      children: [
        {
          kind: 'toolResult',
          name: null,
          status: 'ok',
          parts: [{ type: 'text', text: 'sunny' }],
          body: null,
        },
        {
          kind: 'toolResult',
          name: null,
          status: null,
          parts: null,
          body: { kind: 'text', value: '[{"type":"text","text":"sunny"}]' },
        },
      ],
    });
  });
});
