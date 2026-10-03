import { describe, expect, it } from 'vitest';
import { testRun } from '../trace-profiles/langgraph/aggregates/test-helpers';
import {
  buildSampleGroups,
  collectRunRefs,
  DEFAULT_TRUNCATE_LIMITS,
  estimateTokens,
  fitToBudget,
  groupRunRefs,
  inferShape,
  pickSpread,
  planSamples,
  sampleGroupChars,
  truncatePayload,
} from './sampling';

const llm = (id: string) =>
  testRun({
    runId: id,
    name: 'ChatOpenAI',
    type: 'chat_model',
    inputRef: `${id}-in`,
    outputRef: `${id}-out`,
  });
const tree = {
  traceId: 't1',
  root: testRun({
    runId: 'root',
    name: 'graph',
    type: 'chain',
    inputRef: 'root-in',
    children: [
      llm('a'),
      llm('b'),
      llm('c'),
      llm('d'),
      testRun({ runId: 'tool', name: 'search', type: 'tool', outputRef: 'tool-out' }),
    ],
  }),
};

describe('grouping and planning', () => {
  it('groups refs by type, name and side, largest first', () => {
    const groups = groupRunRefs(collectRunRefs([tree]));
    expect(groups.map((g) => [g.key, g.refs.length])).toEqual([
      ['chat_model · ChatOpenAI · input', 4],
      ['chat_model · ChatOpenAI · output', 4],
      ['chain · graph · input', 1],
      ['tool · search · output', 1],
    ]);
  });

  it('pickSpread takes evenly spaced items including first and last', () => {
    expect(pickSpread([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([1, 4, 7]);
    expect(pickSpread([1, 2], 3)).toEqual([1, 2]);
    expect(pickSpread([1, 2, 3], 1)).toEqual([1]);
    expect(pickSpread([1, 2, 3], 0)).toEqual([]);
  });

  it('plans per-group samples with pinned refs and priority first', () => {
    const groups = groupRunRefs(collectRunRefs([tree]));
    const planned = planSamples(groups, {
      perGroup: 2,
      maxGroups: 3,
      pinned: ['tool-out'],
      priority: (g) => (g.side === 'output' ? 1 : 0),
    });
    expect(planned.map((g) => g.key)).toEqual([
      'tool · search · output',
      'chat_model · ChatOpenAI · output',
      'chat_model · ChatOpenAI · input',
    ]);
    expect(planned[1].refs.map((r) => r.ref)).toEqual(['a-out', 'd-out']);
  });
});

describe('truncatePayload', () => {
  const limits = { ...DEFAULT_TRUNCATE_LIMITS, maxString: 5, maxArray: 2, maxDepth: 2, maxKeys: 2 };

  it('truncates strings, arrays, depth and keys with visible markers', () => {
    expect(truncatePayload({ a: 'abcdefgh', b: [1, 2, 3], c: 1 }, limits)).toEqual({
      a: 'abcde…‹+3 chars›',
      b: [1, 2, '‹+1 more items›'],
      '‹more keys›': 1,
    });
    expect(truncatePayload({ a: { b: { c: 1 } } }, limits)).toEqual({ a: { b: '‹object›' } });
  });

  it('redacts long strings but keeps short ones when enabled', () => {
    expect(
      truncatePayload(
        { role: 'user', content: 'x'.repeat(50) },
        { ...DEFAULT_TRUNCATE_LIMITS, redactStrings: true },
      ),
    ).toEqual({ role: 'user', content: '‹redacted 50 chars›' });
  });
});

describe('inferShape', () => {
  it('merges objects, marks optional fields and keeps short string literals', () => {
    expect(
      inferShape([
        { messages: [{ type: 'human', content: 'hi' }] },
        { messages: [{ type: 'ai', content: [{ type: 'text', text: 'yo' }] }], extra: 1 },
      ]),
    ).toBe(
      '{ messages: Array<{ type: "human" | "ai"; content: "hi" | Array<{ type: "text"; text: "yo" }> }>; extra?: number }',
    );
  });

  it('falls back to string when values are long, many, or truncated', () => {
    expect(inferShape(['a'.repeat(40)])).toBe('string');
    expect(inferShape(['1', '2', '3', '4', '5', '6', '7'])).toBe('string');
    expect(inferShape([null, 3])).toBe('null | number');
    expect(inferShape([[]])).toBe('Array<never>');
  });
});

describe('buildSampleGroups / fitToBudget', () => {
  const groups = groupRunRefs(collectRunRefs([tree]));
  const payloads: Record<string, unknown> = {
    'a-out': { text: 'x'.repeat(400) },
    'd-out': { text: 'y'.repeat(400) },
    'tool-out': { ok: true },
  };

  it('keeps originals, truncates payloads, and drops groups without loaded samples', () => {
    const built = buildSampleGroups(planSamples(groups, { perGroup: 2 }), payloads, groups, {
      ...DEFAULT_TRUNCATE_LIMITS,
      maxString: 10,
    });
    expect(built.map((g) => [g.key, g.samples.length, g.runCount])).toEqual([
      ['chat_model · ChatOpenAI · output', 2, 4],
      ['tool · search · output', 1, 1],
    ]);
    expect(built[0].samples[0]).toMatchObject({
      runId: 'a',
      original: payloads['a-out'],
      payload: { text: 'xxxxxxxxxx…‹+390 chars›' },
    });
    expect(built[0].shape).toBe('{ text: string }');
  });

  it('drops samples from the biggest group first, keeping at least one per group', () => {
    const built = buildSampleGroups(planSamples(groups, { perGroup: 2 }), payloads, groups);
    const fitted = fitToBudget(built, 700);
    expect(fitted.map((g) => g.samples.length)).toEqual([1, 1]);
    expect(fitted.reduce((n, g) => n + sampleGroupChars(g), 0)).toBeLessThanOrEqual(700);
    expect(fitToBudget(built, 10)).toHaveLength(1);
    expect(estimateTokens(400)).toBe(100);
  });
});

describe('applyLimits', () => {
  it('re-truncates from originals and recomputes the shape', async () => {
    const { applyLimits } = await import('./sampling');
    const group = {
      key: 'k',
      runType: 'tool',
      runName: 'x',
      side: 'output' as const,
      runCount: 1,
      shape: 'old',
      samples: [
        {
          traceId: 't',
          runId: 'r',
          ref: 'x',
          payload: {},
          original: { text: 'y'.repeat(80), role: 'user' },
        },
      ],
    };
    const redacted = applyLimits(group, { ...DEFAULT_TRUNCATE_LIMITS, redactStrings: true });
    expect(redacted.samples[0].payload).toEqual({ text: '‹redacted 80 chars›', role: 'user' });
    expect(redacted.shape).toBe('{ text: string; role: "user" }');
    expect(group.samples[0].payload).toEqual({});
  });
});
