import { describe, expect, it, vi } from 'vitest';
import { DynamoStructureStoreAdapter } from './dynamo-structure-store-adapter.js';
import type { Trace, TraceRun } from './types.js';

describe('DynamoStructureStoreAdapter', () => {
  it('upserts and reads traces with runs', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const client = createMockClient(store);
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client });

    const trace = makeTrace();
    const run = makeRun();
    await adapter.upsertTrace(trace);
    await adapter.upsertRun(run);

    await expect(adapter.getTrace('trace-1')).resolves.toEqual({ trace, runs: [run] });
  });

  it('lists traces from the start-time index', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const client = createMockClient(store);
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client });

    await adapter.upsertTrace(makeTrace({ traceId: 'older', startTime: '2026-01-01T00:00:00.000Z' }));
    await adapter.upsertTrace(
      makeTrace({ traceId: 'newer', startTime: '2026-01-02T00:00:00.000Z', status: 'success' }),
    );

    await expect(adapter.listTraces({ status: 'success', limit: 10 })).resolves.toEqual({
      traces: [expect.objectContaining({ traceId: 'newer' })],
    });
  });

  it('patches trace and run annotations', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const client = createMockClient(store);
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client });
    await adapter.upsertTrace(makeTrace({ annotation: { review: { status: 'open' } } }));
    await adapter.upsertRun(makeRun());

    await expect(
      adapter.patchTraceAnnotation({
        traceId: 'trace-1',
        annotation: { review: { author: 'pascal' } },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        annotation: { review: { status: 'open', author: 'pascal' } },
      }),
    );

    await expect(
      adapter.patchRunAnnotation({
        traceId: 'trace-1',
        runId: 'run-1',
        annotation: { note: 'check' },
      }),
    ).resolves.toEqual(expect.objectContaining({ annotation: { note: 'check' } }));
  });
});

function createMockClient(store: Map<string, Record<string, unknown>>) {
  const itemKey = (pk: string, sk: string) => `${pk}::${sk}`;

  return {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      const input = command.input;

      if (name === 'PutCommand') {
        const item = input.Item as Record<string, unknown>;
        store.set(itemKey(String(item.pk), String(item.sk)), item);
        return {};
      }

      if (name === 'GetCommand') {
        const key = input.Key as { pk: string; sk: string };
        return { Item: store.get(itemKey(key.pk, key.sk)) };
      }

      if (name === 'QueryCommand') {
        const pk = (input.ExpressionAttributeValues as Record<string, string>)?.[':pk'];
        if (pk) {
          const items = [...store.values()].filter((item) => item.pk === pk);
          return { Items: items };
        }

        const listPk = (input.ExpressionAttributeValues as Record<string, string>)?.[':listPk'];
        let items = [...store.values()].filter((item) => item.listPk === listPk && item.trace);
        const filter = input.FilterExpression as string | undefined;
        const values = input.ExpressionAttributeValues as Record<string, string>;
        if (filter?.includes('trace.projectId')) {
          items = items.filter(
            (item) => (item.trace as Trace).projectId === values[':projectId'],
          );
        }
        if (filter?.includes('trace.#status')) {
          items = items.filter((item) => (item.trace as Trace).status === values[':status']);
        }
        items.sort((left, right) =>
          String(right.listSk).localeCompare(String(left.listSk)),
        );
        const limit = input.Limit as number | undefined;
        return { Items: limit ? items.slice(0, limit) : items };
      }

      throw new Error(`Unexpected command: ${name}`);
    }),
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    rootRunId: 'run-1',
    projectId: 'demo',
    name: 'Trace 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    runCount: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    schemaVersion: 1,
    traceId: 'trace-1',
    runId: 'run-1',
    type: 'chain',
    name: 'Run 1',
    status: 'running',
    startTime: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
