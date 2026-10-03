import { describe, expect, it } from 'vitest';
import { STARTER_MAPPING } from './mapping-schema';
import {
  appendVersion,
  createProfile,
  currentMapping,
  duplicateProfile,
  exportProfile,
  fromTraceProfileId,
  importProfile,
  latestSamples,
  mergeStoredSamples,
  fromStoredSamples,
  toStoredSamples,
  MAX_PROFILE_VERSIONS,
  parseStore,
  restoreVersion,
  serializeStore,
  toTraceProfileId,
} from './profile-store';

const NOW = '2026-10-03T00:00:00.000Z';
const make = () =>
  createProfile(
    { name: 'Agent', mapping: STARTER_MAPPING, source: 'manual' },
    { id: 'p1', now: NOW },
  );

describe('profile ids', () => {
  it('round-trips custom trace profile ids', () => {
    expect(toTraceProfileId('p1')).toBe('custom:p1');
    expect(fromTraceProfileId('custom:p1')).toBe('p1');
    expect(fromTraceProfileId('langgraph')).toBeNull();
  });
});

describe('store parse / serialize', () => {
  it('round-trips a valid store', () => {
    const store = { profiles: [make()] };
    expect(parseStore(serializeStore(store))).toEqual({ store, warnings: [] });
  });

  it('handles empty, corrupt and malformed input', () => {
    expect(parseStore(null)).toEqual({ store: { profiles: [] }, warnings: [] });
    expect(parseStore('{nope').warnings).toHaveLength(1);
    expect(parseStore('{"x":1}').warnings).toHaveLength(1);
  });

  it('skips invalid and duplicate profiles but keeps valid ones', () => {
    const good = make();
    const bad = { ...good, id: 'p2', name: 'Broken', currentVersion: 9 };
    const { store, warnings } = parseStore(JSON.stringify({ profiles: [good, bad, good] }));
    expect(store.profiles.map((p) => p.id)).toEqual(['p1']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('Broken');
  });
});

describe('versions', () => {
  it('appends versions and makes them current', () => {
    const next = appendVersion(
      make(),
      { schemaVersion: 1, rules: [] },
      { source: 'improved', model: 'm' },
      NOW,
    );
    expect(next.currentVersion).toBe(2);
    expect(currentMapping(next).rules).toEqual([]);
    expect(next.versions[1]).toMatchObject({ source: 'improved', model: 'm' });
  });

  it('caps history at MAX_PROFILE_VERSIONS while keeping numbering monotonic', () => {
    let p = make();
    for (let i = 0; i < MAX_PROFILE_VERSIONS + 5; i++) {
      p = appendVersion(p, STARTER_MAPPING, { source: 'manual' }, NOW);
    }
    expect(p.versions).toHaveLength(MAX_PROFILE_VERSIONS);
    expect(p.currentVersion).toBe(MAX_PROFILE_VERSIONS + 6);
    expect(p.versions[0].version).toBe(7);
  });

  it('restores by appending a copy, and throws for unknown versions', () => {
    const p = appendVersion(make(), { schemaVersion: 1, rules: [] }, { source: 'manual' }, NOW);
    const restored = restoreVersion(p, 1, NOW);
    expect(restored.currentVersion).toBe(3);
    expect(currentMapping(restored)).toEqual(STARTER_MAPPING);
    expect(restored.versions[2].note).toBe('Restored from v1');
    expect(() => restoreVersion(p, 42)).toThrow('Version 42 not found');
  });

  it('duplicates the current mapping into a fresh profile', () => {
    const copy = duplicateProfile(make(), { id: 'p9', now: NOW });
    expect(copy).toMatchObject({ id: 'p9', name: 'Agent (copy)', currentVersion: 1 });
    expect(currentMapping(copy)).toEqual(STARTER_MAPPING);
  });
});

describe('import / export', () => {
  it('round-trips an exported profile', () => {
    const json = JSON.stringify(exportProfile(make()));
    const result = importProfile(json, { id: 'p2', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toMatchObject({ id: 'p2', name: 'Agent' });
      expect(result.profile.versions[0].source).toBe('imported');
    }
  });

  it('imports a bare mapping with a fallback name', () => {
    const result = importProfile(JSON.stringify(STARTER_MAPPING), { fallbackName: 'Pasted' });
    expect(result.ok && result.profile.name).toBe('Pasted');
  });

  it('reports JSON and schema errors', () => {
    expect(importProfile('{')).toMatchObject({ ok: false });
    const invalid = importProfile(JSON.stringify({ schemaVersion: 1, rules: [{ id: 'x' }] }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.length).toBeGreaterThan(0);
  });
});

describe('regression samples', () => {
  const group = (key: string, refs: string[], size = 1) => ({
    key,
    runType: 'tool',
    runName: key,
    side: 'output' as const,
    samples: refs.map((ref) => ({
      traceId: 't',
      runId: ref,
      ref,
      payload: { text: 'x'.repeat(size) },
    })),
  });

  it('keeps samples only on the newest version and merges them forward', () => {
    let p = appendVersion(
      make(),
      STARTER_MAPPING,
      { source: 'generated', samples: [group('a', ['1'])] },
      NOW,
    );
    p = appendVersion(
      p,
      STARTER_MAPPING,
      { source: 'improved', samples: [group('a', ['2', '1']), group('b', ['3'])] },
      NOW,
    );
    expect(p.versions[1].samples).toBeUndefined();
    expect(latestSamples(p).map((g) => [g.key, g.samples.map((s) => s.ref)])).toEqual([
      ['a', ['2', '1']],
      ['b', ['3']],
    ]);
    // A manual edit without samples carries the latest samples forward.
    p = appendVersion(p, STARTER_MAPPING, { source: 'manual' }, NOW);
    expect(p.versions.at(-1)?.samples).toHaveLength(2);
    expect(p.versions.at(-2)?.samples).toBeUndefined();
    // Survives a store round-trip.
    expect(parseStore(serializeStore({ profiles: [p] })).store.profiles[0]).toEqual(p);
  });

  it('caps stored samples while keeping one sample per group', () => {
    const merged = mergeStoredSamples(
      [group('a', ['1', '2', '3'], 500)],
      [group('b', ['4', '5'], 500)],
      1500,
    );
    expect(merged.map((g) => g.samples.length)).toEqual([1, 1]);
    expect(JSON.stringify(merged).length).toBeLessThanOrEqual(1500);
  });

  it('round-trips between sample groups and stored samples', () => {
    const stored = [group('a', ['1'])];
    const groups = fromStoredSamples(stored);
    expect(groups[0]).toMatchObject({
      runCount: 1,
      samples: [{ ref: '1', original: { text: 'x' } }],
    });
    expect(toStoredSamples(groups)).toEqual(stored);
  });
});
