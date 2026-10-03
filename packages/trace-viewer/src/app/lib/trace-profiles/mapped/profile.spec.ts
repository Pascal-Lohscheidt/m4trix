import { describe, expect, expectTypeOf, it } from 'vitest';
import { STARTER_MAPPING } from '../../payload-mapper/mapping-schema';
import { appendVersion, createProfile } from '../../payload-mapper/profile-store';
import { getTraceProfile, resolveTraceProfiles, type TraceProfileId } from '../index';
import { testRun } from '../langgraph/aggregates/test-helpers';
import { createMappedProfile } from './profile';

const base = createProfile(
  { name: 'Support agent', mapping: STARTER_MAPPING, source: 'manual' },
  { id: 'p1', now: '2026-10-03T00:00:00.000Z' },
);

const withUsage = appendVersion(
  base,
  {
    ...STARTER_MAPPING,
    usage: [{ match: { runType: ['chat_model'] }, inputTokens: '$.u.in', outputTokens: '$.u.out' }],
  },
  { source: 'manual' },
);

const root = testRun({
  runId: 'r',
  name: 'graph',
  type: 'chain',
  children: [testRun({ runId: 'l', name: 'llm', type: 'chat_model', outputRef: 'o' })],
});
const trace = { traceId: 't', name: 'graph', status: 'success', startTime: 't0', runCount: 2 };

describe('createMappedProfile', () => {
  it('derives id, kind and description from the stored profile', () => {
    const profile = createMappedProfile(base);
    expect(profile).toMatchObject({
      id: 'custom:p1',
      kind: 'custom',
      label: 'Support agent',
      removable: true,
    });
    expect(profile.description).toBe('2 rules · v1');
    expectTypeOf(profile.id).toEqualTypeOf<TraceProfileId>();
  });

  it('has no aggregates or subtree rollups without usage rules', () => {
    const profile = createMappedProfile(base);
    expect(profile.requiresFullPayloads).toBe(false);
    expect(profile.buildSubtreeRollups).toBeUndefined();
    expect(
      profile.buildAggregates({ trace, root, payloadCache: {}, fullTracePayloadsLoaded: false }),
    ).toEqual({
      cards: [],
    });
  });

  it('uses the current version and builds usage cards once payloads are loaded', () => {
    const profile = createMappedProfile(withUsage);
    expect(profile.requiresFullPayloads).toBe(true);
    expect(profile.description).toContain('v2 · token aggregates');
    expect(
      profile.buildAggregates({ trace, root, payloadCache: {}, fullTracePayloadsLoaded: false }),
    ).toEqual({
      pendingReason: 'missing_trace_payloads',
      cards: [],
    });
    const payloadCache = { o: { u: { in: 7, out: 3 } } };
    const { cards } = profile.buildAggregates({
      trace,
      root,
      payloadCache,
      fullTracePayloadsLoaded: true,
    });
    expect(cards).toContainEqual({ id: 'tokens-total', label: 'Tokens (total est.)', value: '10' });
    expect(profile.buildSubtreeRollups?.(root, payloadCache).get('r')).toMatchObject({
      totalTokens: 10,
    });
  });
});

describe('resolveTraceProfiles / getTraceProfile', () => {
  it('appends custom profiles after built-ins', () => {
    const profiles = resolveTraceProfiles([base]);
    expect(profiles.map((p) => p.id)).toEqual(['raw', 'langgraph', 'custom:p1']);
    expect(getTraceProfile('custom:p1', profiles).label).toBe('Support agent');
  });

  it('falls back to raw for unknown ids', () => {
    expect(getTraceProfile('custom:deleted', resolveTraceProfiles([])).id).toBe('raw');
    expect(getTraceProfile('langgraph').id).toBe('langgraph');
  });
});
