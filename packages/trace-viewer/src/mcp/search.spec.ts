import type { TraceRun } from '@m4trix/tracing';
import { describe, expect, it } from 'vitest';
import { flattenLeaves } from './json-utils';
import type { IndexedPayload, IndexedTrace, PayloadSide } from './payload-index';
import { compileSearchPattern, searchPayloads } from './search';

function run(runId: string, startTime: string, endTime: string, parentRunId?: string): TraceRun {
  return {
    schemaVersion: 1,
    traceId: 't1',
    runId,
    ...(parentRunId ? { parentRunId } : {}),
    type: 'chain',
    name: runId,
    status: 'success',
    startTime,
    endTime,
  };
}

function payload(runId: string, side: PayloadSide, value: unknown): IndexedPayload {
  return { ref: `${runId}/${side}`, runId, side, value, leaves: flattenLeaves(value), size: 0 };
}

/** Parent starts first but echoes the child's output in its own output, which ends last. */
function stateEchoTrace(): IndexedTrace {
  const runs = [
    run('parent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'),
    run('child', '2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z', 'parent'),
  ];
  const payloads = [
    payload('parent', 'input', { messages: ['hello'] }),
    payload('parent', 'output', { messages: ['hello', 'Planned: step 1'] }),
    payload('child', 'input', { messages: ['hello'] }),
    payload('child', 'output', { messages: ['hello', 'Planned: step 1'] }),
  ];
  return {
    trace: {
      schemaVersion: 1,
      traceId: 't1',
      rootRunId: 'parent',
      name: 't',
      status: 'success',
      startTime: '2026-01-01T00:00:00Z',
      runCount: 2,
    },
    runs: new Map(runs.map((item) => [item.runId, item])),
    payloads: new Map(payloads.map((item) => [item.ref, item])),
    size: 0,
    failures: [],
  };
}

describe('searchPayloads', () => {
  it('attributes a value to the run whose output produced it', () => {
    const result = searchPayloads([stateEchoTrace()], { query: 'planned' });
    expect(result.totalOccurrences).toBe(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].first).toMatchObject({ side: 'output', path: '$.messages[1]' });
    expect(result.groups[0].first.run.runId).toBe('child');
  });

  it('attributes inputs at run start, before any output', () => {
    const result = searchPayloads([stateEchoTrace()], { query: 'hello' });
    expect(result.groups[0].first.run.runId).toBe('parent');
    expect(result.groups[0].first.side).toBe('input');
    expect(result.groups[0].occurrences).toHaveLength(4);
  });

  it('filters by side and path prefix', () => {
    expect(
      searchPayloads([stateEchoTrace()], { query: 'hello', side: 'output' }).totalOccurrences,
    ).toBe(2);
    expect(
      searchPayloads([stateEchoTrace()], { query: 'hello', pathPrefix: '$.other' }).groups,
    ).toEqual([]);
  });
});

describe('compileSearchPattern', () => {
  it('escapes plain text and honours case sensitivity', () => {
    expect(compileSearchPattern({ query: 'a.b' }).test('axb')).toBe(false);
    expect(compileSearchPattern({ query: 'A.B' }).test('a.b')).toBe(true);
    expect(compileSearchPattern({ query: 'A.B', caseSensitive: true }).test('a.b')).toBe(false);
    expect(compileSearchPattern({ query: 'a.b', regex: true }).test('axb')).toBe(true);
  });
});
