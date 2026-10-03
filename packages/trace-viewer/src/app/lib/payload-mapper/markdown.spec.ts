import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('tokenizes code, bold, italic and safe links', () => {
    expect(parseInline('a `b` **c** *d* [e](https://x.y)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: 'b' },
      { type: 'text', text: ' ' },
      { type: 'bold', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'italic', text: 'd' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'e', href: 'https://x.y' },
    ]);
  });

  it('keeps unsafe links as plain text', () => {
    expect(parseInline('[x](javascript:alert(1))')[0]).toMatchObject({ type: 'text' });
  });
});

describe('parseMarkdown', () => {
  it('parses headings, lists, quotes, fences, rules and paragraphs', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        '- a',
        '- b',
        '1. one',
        '> quoted',
        '```ts',
        'const x = 1;',
        '```',
        '---',
        'para',
        'line',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'list',
      'list',
      'quote',
      'code',
      'rule',
      'paragraph',
    ]);
    expect(blocks[4]).toEqual({ type: 'code', language: 'ts', text: 'const x = 1;' });
    expect(blocks[2]).toMatchObject({ ordered: true });
  });

  it('treats html as text', () => {
    expect(parseMarkdown('<script>x</script>')).toEqual([
      { type: 'paragraph', inlines: [{ type: 'text', text: '<script>x</script>' }] },
    ]);
  });
});
