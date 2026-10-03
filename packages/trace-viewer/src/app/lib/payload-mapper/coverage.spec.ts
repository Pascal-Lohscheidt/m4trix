import { describe, expect, it } from 'vitest';
import { testRun } from '../trace-profiles/langgraph/aggregates/test-helpers';
import {
  computeCoverage,
  coverageForSamples,
  coverageForTree,
  evaluateSample,
  formatCoveragePercent,
} from './coverage';
import type { PayloadMapping } from './mapping-schema';

const mapping: PayloadMapping = {
  schemaVersion: 1,
  rules: [
    {
      id: 'chat',
      match: { runType: ['chat_model'], requires: ['$.messages'] },
      view: { kind: 'messages', items: '$.messages[*]', role: '$.role' },
    },
    { id: 'broken', match: { runType: ['tool'] }, view: { kind: 'markdown', value: '$.nope' } },
    {
      id: 'nested',
      match: { runType: ['retriever'] },
      view: { kind: 'stack', children: [{ kind: 'json' }, { kind: 'text', value: '$.missing' }] },
    },
  ],
};
const chat = { type: 'chat_model', name: 'llm' };

describe('evaluateSample', () => {
  it('classifies mapped, partial, fallback and unmatched', () => {
    expect(
      evaluateSample(mapping, chat, 'input', { messages: [{ role: 'user', content: 'hi' }] }),
    ).toEqual({
      outcome: 'mapped',
      ruleId: 'chat',
      issues: [],
    });
    expect(
      evaluateSample(mapping, chat, 'input', { messages: [{ type: 'human', content: 'hi' }] }),
    ).toMatchObject({
      outcome: 'partial',
      issues: ['messages.role: no match for $.role'],
    });
    expect(evaluateSample(mapping, { type: 'tool', name: 't' }, 'output', {})).toMatchObject({
      outcome: 'fallback',
      ruleId: 'broken',
    });
    expect(evaluateSample(mapping, { type: 'retriever', name: 'r' }, 'output', {}).outcome).toBe(
      'partial',
    );
    expect(evaluateSample(mapping, chat, 'input', { prompt: 'x' })).toEqual({
      outcome: 'unmatched',
      ruleId: null,
      issues: [],
    });
  });
});

describe('computeCoverage', () => {
  it('aggregates per group, sorts problem groups first and scores partial as half', () => {
    const report = computeCoverage(mapping, [
      { run: chat, side: 'input', payload: { messages: [{ role: 'user' }] } },
      { run: chat, side: 'input', payload: { messages: [{ type: 'human' }] } },
      { run: { type: 'tool', name: 't' }, side: 'output', payload: {} },
      { run: { type: 'chain', name: 'c' }, side: 'output', payload: {} },
    ]);
    expect(report).toMatchObject({
      total: 4,
      mapped: 1,
      partial: 1,
      fallback: 1,
      unmatched: 1,
      score: 1.5 / 4,
    });
    expect(report.groups[2]).toMatchObject({
      key: 'chat_model · llm · input',
      total: 2,
      ruleIds: ['chat'],
    });
    expect(formatCoveragePercent(report.score)).toBe('38%');
    expect(computeCoverage(mapping, []).score).toBe(0);
  });

  it('works from a loaded trace tree and from sample groups', () => {
    const root = testRun({
      runId: 'r',
      name: 'llm',
      type: 'chat_model',
      inputRef: 'i',
      outputRef: 'o',
    });
    expect(coverageForTree(mapping, root, { i: { messages: [{ role: 'user' }] } })).toMatchObject({
      total: 1,
      mapped: 1,
    });
    expect(
      coverageForSamples(mapping, [
        {
          key: 'k',
          runType: 'chat_model',
          runName: 'llm',
          side: 'input',
          runCount: 1,
          shape: '',
          samples: [
            {
              traceId: 't',
              runId: 'r',
              ref: 'i',
              payload: {},
              original: { messages: [{ role: 'user' }] },
            },
          ],
        },
      ]),
    ).toMatchObject({ total: 1, mapped: 1 });
  });
});
