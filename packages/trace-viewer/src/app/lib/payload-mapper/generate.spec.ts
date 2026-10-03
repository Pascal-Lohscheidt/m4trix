import { describe, expect, it } from 'vitest';
import { dryRunProblems, GenerationError, runMappingGeneration } from './generate';
import { computeCoverage } from './coverage';
import type { PayloadMapping } from './mapping-schema';
import type { GenerateRequest, MapperProvider } from './providers/types';
import type { SampleGroup } from './sampling';

const group: SampleGroup = {
  key: 'tool · search · output',
  runType: 'tool',
  runName: 'search',
  side: 'output',
  runCount: 2,
  shape: '{ content: string }',
  samples: [
    {
      traceId: 't',
      runId: 'r1',
      ref: 'x',
      payload: { content: 'hi' },
      original: { content: 'hi' },
    },
  ],
};

const good: PayloadMapping = {
  schemaVersion: 1,
  rules: [
    { id: 'tool', match: { runType: ['tool'] }, view: { kind: 'markdown', value: '$.content' } },
  ],
};
const broken: PayloadMapping = {
  schemaVersion: 1,
  rules: [
    { id: 'tool', match: { runType: ['tool'] }, view: { kind: 'markdown', value: '$.text' } },
  ],
};

/** Provider that replays scripted answers and records requests. */
function scripted(...answers: string[]) {
  const requests: GenerateRequest[] = [];
  const provider: MapperProvider = {
    id: 'anthropic',
    async generate(request) {
      requests.push(request);
      const text = answers.shift();
      if (text === undefined) throw new Error('no more answers');
      return { text, model: 'm', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { provider, requests };
}

const answer = (mapping: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Agent',
    description: 'd',
    mapping,
    changes: ['added tool rule'],
    ...extra,
  });

describe('runMappingGeneration', () => {
  it('returns a valid mapping on the first attempt with coverage and usage', async () => {
    const { provider, requests } = scripted(answer(good));
    const events: string[] = [];
    const result = await runMappingGeneration({
      provider,
      mode: 'create',
      groups: [group],
      onProgress: (e) => events.push(e.type),
    });
    expect(result).toMatchObject({
      name: 'Agent',
      changes: ['added tool rule'],
      unresolved: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result.coverage).toMatchObject({ total: 1, mapped: 1 });
    expect(requests[0].cacheablePrefix).toContain('Create a mapping');
    expect(requests[0].prompt).toBe('');
    expect(events).toEqual(['request', 'response']);
  });

  it('repairs invalid JSON, schema errors and broken views, sending the problems back', async () => {
    const { provider, requests } = scripted(
      'not json',
      answer({ schemaVersion: 1, rules: [{ id: 'x' }] }),
      answer(broken),
      answer(good),
    );
    const result = await runMappingGeneration({
      provider,
      mode: 'create',
      groups: [group],
      maxRepairs: 3,
    });
    expect(result.attempts.map((a) => a.problems.length > 0)).toEqual([true, true, true, false]);
    expect(requests[1].prompt).toContain('did not contain a JSON object');
    expect(requests[3].prompt).toContain('could not render 1/1 samples');
    expect(requests.every((r) => r.cacheablePrefix === requests[0].cacheablePrefix)).toBe(true);
    expect(result.usage.outputTokens).toBe(20);
  });

  it('returns the best valid candidate with unresolved problems when repairs run out', async () => {
    const { provider } = scripted(answer(broken), 'still not json');
    const result = await runMappingGeneration({
      provider,
      mode: 'create',
      groups: [group],
      maxRepairs: 1,
    });
    expect(result.mapping).toEqual(broken);
    expect(result.unresolved[0]).toContain('could not render');
  });

  it('throws GenerationError when no valid mapping was produced', async () => {
    const { provider } = scripted('x', 'y');
    const err = await runMappingGeneration({
      provider,
      mode: 'create',
      groups: [group],
      maxRepairs: 1,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.attempts).toHaveLength(2);
    expect(err.lastAnswer).toBe('y');
  });

  it('improve mode reports before/after coverage and flags regressions on stored samples', async () => {
    const regression: SampleGroup = {
      ...group,
      key: 'tool · search · output',
      samples: [{ ...group.samples[0], runId: 'old' }],
    };
    const { provider, requests } = scripted(answer(broken), answer(good));
    const result = await runMappingGeneration({
      provider,
      mode: 'improve',
      current: good,
      groups: [group],
      regressionGroups: [regression],
      instruction: 'keep it',
    });
    expect(requests[0].cacheablePrefix).toContain('Improve this existing mapping');
    expect(requests[0].cacheablePrefix).toContain('User instruction: keep it');
    expect(requests[1].prompt).toContain('Regression on "tool · search · output"');
    expect(result.before).toMatchObject({ total: 2, mapped: 2 });
    expect(result.coverage).toMatchObject({ total: 2, mapped: 2 });
  });

  it('requires the current mapping when improving', async () => {
    await expect(
      runMappingGeneration({ provider: scripted().provider, mode: 'improve', groups: [group] }),
    ).rejects.toThrow('requires the current mapping');
  });
});

describe('dryRunProblems', () => {
  it('reports only broken groups and regressions', () => {
    const after = computeCoverage(broken, [
      { run: { type: 'tool', name: 'search' }, side: 'output', payload: { content: 'x' } },
    ]);
    const before = computeCoverage(good, [
      { run: { type: 'tool', name: 'search' }, side: 'output', payload: { content: 'x' } },
    ]);
    const problems = dryRunProblems(after, before);
    expect(problems).toHaveLength(2);
    expect(dryRunProblems(before)).toEqual([]);
  });
});
