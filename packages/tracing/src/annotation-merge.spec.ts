import { describe, expect, it } from 'vitest';
import { mergeTraceAnnotation } from './annotation-merge.js';

describe('mergeTraceAnnotation', () => {
  it('deep-merges nested objects by default', () => {
    expect(
      mergeTraceAnnotation(
        { review: { status: 'open', author: 'a' }, tags: ['x'] },
        { review: { note: 'looks good' }, tags: ['y'] },
      ),
    ).toEqual({
      review: { status: 'open', author: 'a', note: 'looks good' },
      tags: ['y'],
    });
  });

  it('replaces the whole annotation when merge is false', () => {
    expect(mergeTraceAnnotation({ a: 1, b: { c: 2 } }, { b: { d: 3 } }, false)).toEqual({
      b: { d: 3 },
    });
  });

  it('clears annotation when merge is false and incoming is empty', () => {
    expect(mergeTraceAnnotation({ a: 1 }, {}, false)).toBeUndefined();
  });

  it('creates annotation from undefined existing state', () => {
    expect(mergeTraceAnnotation(undefined, { label: 'bug' })).toEqual({ label: 'bug' });
  });
});
