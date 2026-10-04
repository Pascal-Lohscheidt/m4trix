import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Trace, TraceRun } from '../types.js';
import {
  DynamoStructureStoreAdapter,
  resolveDynamoStructureStoreOptionsFromEnv,
} from './dynamo-structure-store-adapter.js';

describe('resolveDynamoStructureStoreOptionsFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads list sharding and the project index from the environment', () => {
    vi.stubEnv('TRACE_DYNAMO_TABLE', 'traces');
    vi.stubEnv('TRACE_DYNAMO_LIST_SHARDS', '8');
    vi.stubEnv('TRACE_DYNAMO_PROJECT_INDEX', 'byProject');

    expect(resolveDynamoStructureStoreOptionsFromEnv()).toMatchObject({
      tableName: 'traces',
      listShards: 8,
      projectIndexName: 'byProject',
    });
  });

  it('prefers explicit overrides and keeps options the environment does not cover', () => {
    vi.stubEnv('TRACE_DYNAMO_TABLE', 'traces');
    vi.stubEnv('TRACE_DYNAMO_LIST_SHARDS', '8');

    expect(
      resolveDynamoStructureStoreOptionsFromEnv({ listShards: 2, maxConcurrentWrites: 4 }),
    ).toMatchObject({ listShards: 2, maxConcurrentWrites: 4 });
  });

  it('rejects a list shard count that is not a positive integer', () => {
    vi.stubEnv('TRACE_DYNAMO_TABLE', 'traces');
    vi.stubEnv('TRACE_DYNAMO_LIST_SHARDS', '0');

    expect(() => resolveDynamoStructureStoreOptionsFromEnv()).toThrow('TRACE_DYNAMO_LIST_SHARDS');
  });
});

describe('DynamoStructureStoreAdapter', () => {
  it('upserts and reads traces with runs', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });

    const trace = makeTrace();
    const run = makeRun();
    await adapter.upsertTrace(trace);
    await adapter.upsertRun(run);

    await expect(adapter.getTrace('trace-1')).resolves.toEqual({ trace, runs: [run] });
  });

  it('lists traces from the start-time index', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });

    await adapter.upsertTrace(
      makeTrace({ traceId: 'older', startTime: '2026-01-01T00:00:00.000Z' }),
    );
    await adapter.upsertTrace(
      makeTrace({ traceId: 'newer', startTime: '2026-01-02T00:00:00.000Z', status: 'success' }),
    );

    await expect(adapter.listTraces({ status: 'success', limit: 10 })).resolves.toEqual({
      traces: [expect.objectContaining({ traceId: 'newer' })],
    });
  });

  it('pages through traces newest first with a cursor', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    const traceIds = await upsertTracesAtDays(adapter, 5);

    const pages = await collectPages(adapter, { limit: 2 });

    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(traceIds.toReversed());
  });

  it('fills a page even when the filter skips most evaluated items', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    for (let day = 1; day <= 9; day++) {
      await adapter.upsertTrace(
        makeTrace({
          traceId: `t${day}`,
          startTime: dayIso(day),
          status: day % 3 === 0 ? 'error' : 'success',
        }),
      );
    }

    const page = await adapter.listTraces({ status: 'error', limit: 2 });

    expect(page.traces.map((trace) => trace.traceId)).toEqual(['t9', 't6']);
    const rest = await adapter.listTraces({ status: 'error', limit: 2, cursor: page.nextCursor });
    expect(rest.traces.map((trace) => trace.traceId)).toEqual(['t3']);
  });

  it('narrows time ranges with a key condition on the start time', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await upsertTracesAtDays(adapter, 6);

    const between = await adapter.listTraces({ startAfter: dayIso(2), startBefore: dayIso(5) });
    const after = await adapter.listTraces({ startAfter: dayIso(4) });
    const before = await adapter.listTraces({ startBefore: dayIso(3) });

    expect(between.traces.map((trace) => trace.traceId)).toEqual(['t4', 't3']);
    expect(after.traces.map((trace) => trace.traceId)).toEqual(['t6', 't5']);
    expect(before.traces.map((trace) => trace.traceId)).toEqual(['t2', 't1']);
    for (const input of table.sent('QueryCommand').filter((query) => query.IndexName)) {
      expect(input.KeyConditionExpression).toMatch(/#listSk (>|<|BETWEEN)/);
    }
  });

  it('spreads traces over list shards and merges them newest first', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({
      tableName: 'traces',
      client: table.client,
      listShards: 4,
    });
    // Written before sharding was enabled, under the original list key.
    table.put({
      pk: 'legacy',
      sk: 'TRACE',
      listPk: 'PROJECT#_all',
      listSk: dayIso(5, 30),
      trace: makeTrace({ traceId: 'legacy', startTime: dayIso(5, 30) }),
    });
    const traceIds = await upsertTracesAtDays(adapter, 12);

    const pages = await collectPages(adapter, { limit: 5 });

    const expected = [...traceIds, 'legacy'].sort((left, right) =>
      startOf(table, right).localeCompare(startOf(table, left)),
    );
    expect(pages.flat()).toEqual(expected);
    expect(pages.map((page) => page.length)).toEqual([5, 5, 3]);
    const listKeys = new Set(table.items().map((item) => item.listPk));
    expect(listKeys.size).toBeGreaterThan(2);
    expect([...listKeys].every((key) => /^PROJECT#_all(#\d)?$/.test(String(key)))).toBe(true);
  });

  it('queries the project index when one is configured', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({
      tableName: 'traces',
      client: table.client,
      projectIndexName: 'byProject',
    });
    await adapter.upsertTrace(makeTrace({ traceId: 'a1', projectId: 'a', startTime: dayIso(1) }));
    await adapter.upsertTrace(makeTrace({ traceId: 'b1', projectId: 'b', startTime: dayIso(2) }));
    await adapter.upsertTrace(makeTrace({ traceId: 'a2', projectId: 'a', startTime: dayIso(3) }));

    const result = await adapter.listTraces({ projectId: 'a' });

    expect(result.traces.map((trace) => trace.traceId)).toEqual(['a2', 'a1']);
    expect(table.sent('QueryCommand').at(-1)).toMatchObject({ IndexName: 'byProject' });
    expect(table.sent('QueryCommand').at(-1)?.FilterExpression).toBeUndefined();
  });

  it('filters the global list by project when no project index is configured', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await adapter.upsertTrace(makeTrace({ traceId: 'a1', projectId: 'a', startTime: dayIso(1) }));
    await adapter.upsertTrace(makeTrace({ traceId: 'b1', projectId: 'b', startTime: dayIso(2) }));

    const result = await adapter.listTraces({ projectId: 'a' });

    expect(result.traces.map((trace) => trace.traceId)).toEqual(['a1']);
    expect(table.sent('QueryCommand').every((query) => query.IndexName === 'byStartTime')).toBe(
      true,
    );
  });

  it('continues from a cursor issued before list shards existed', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await upsertTracesAtDays(adapter, 4);
    const legacyCursor = Buffer.from(
      JSON.stringify({ pk: 't3', sk: 'TRACE', listPk: 'PROJECT#_all', listSk: dayIso(3) }),
    ).toString('base64url');

    const result = await adapter.listTraces({ cursor: legacyCursor });

    expect(result.traces.map((trace) => trace.traceId)).toEqual(['t2', 't1']);
  });

  it('patches trace and run annotations', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await adapter.upsertTrace(makeTrace({ annotation: { review: { status: 'open' } } }));
    await adapter.upsertRun(makeRun());

    await expect(
      adapter.patchTraceAnnotation({
        traceId: 'trace-1',
        annotation: { review: { author: 'pascal' } },
      }),
    ).resolves.toEqual(makeTrace({ annotation: { review: { status: 'open', author: 'pascal' } } }));

    await expect(
      adapter.patchRunAnnotation({
        traceId: 'trace-1',
        runId: 'run-1',
        annotation: { note: 'check' },
      }),
    ).resolves.toEqual(makeRun({ annotation: { note: 'check' } }));
  });

  it('reads every page of a trace whose runs exceed one query page', async () => {
    const table = createFakeTable({ pageSize: 2 });
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    const runs = Array.from({ length: 5 }, (_, i) => makeRun({ runId: `run-${i}` }));
    await adapter.upsertTrace(makeTrace({ runCount: runs.length }));
    await adapter.upsertRunBatch(runs);

    const record = await adapter.getTrace('trace-1');

    expect(record?.trace).toEqual(makeTrace({ runCount: runs.length }));
    expect(record?.runs).toEqual(runs);
  });

  it('keeps annotations when ingest upserts rewrite traces and runs', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await adapter.upsertTrace(makeTrace());
    await adapter.upsertRun(makeRun());
    await adapter.patchTraceAnnotation({ traceId: 'trace-1', annotation: { verdict: 'bad' } });
    await adapter.patchRunAnnotation({
      traceId: 'trace-1',
      runId: 'run-1',
      annotation: { note: 'slow' },
    });

    await adapter.upsertTrace(makeTrace({ status: 'success' }));
    await adapter.upsertRunBatch([makeRun({ status: 'success' })]);

    await expect(adapter.getTrace('trace-1')).resolves.toEqual({
      trace: makeTrace({ status: 'success', annotation: { verdict: 'bad' } }),
      runs: [makeRun({ status: 'success', annotation: { note: 'slow' } })],
    });
    await expect(adapter.listTraces()).resolves.toEqual({
      traces: [makeTrace({ status: 'success', annotation: { verdict: 'bad' } })],
    });
  });

  it('does not lose annotation edits applied concurrently', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await adapter.upsertTrace(makeTrace());
    await adapter.upsertRun(makeRun());

    await Promise.all([
      adapter.patchTraceAnnotation({ traceId: 'trace-1', annotation: { reviewer1: 'bad' } }),
      adapter.patchTraceAnnotation({ traceId: 'trace-1', annotation: { reviewer2: 'ok' } }),
      adapter.patchRunAnnotation({ traceId: 'trace-1', runId: 'run-1', annotation: { a: 1 } }),
      adapter.patchRunAnnotation({ traceId: 'trace-1', runId: 'run-1', annotation: { b: 2 } }),
    ]);

    expect(table.conflicts).toBeGreaterThan(0);
    await expect(adapter.getTrace('trace-1')).resolves.toEqual({
      trace: makeTrace({ annotation: { reviewer1: 'bad', reviewer2: 'ok' } }),
      runs: [makeRun({ annotation: { a: 1, b: 2 } })],
    });
  });

  it('gives up with an error when annotation writes keep conflicting', async () => {
    const table = createFakeTable({
      beforeUpdate: (item) => {
        item.annotationVersion = Number(item.annotationVersion ?? 0) + 1;
      },
    });
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await adapter.upsertTrace(makeTrace());

    await expect(
      adapter.patchTraceAnnotation({ traceId: 'trace-1', annotation: { verdict: 'bad' } }),
    ).rejects.toThrow('conflicting');
  });

  it('reads legacy annotations stored inside the record and clears them for good', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    table.put({
      pk: 'trace-1',
      sk: 'TRACE',
      listPk: 'PROJECT#_all',
      listSk: '2026-01-01T00:00:00.000Z',
      trace: makeTrace({ annotation: { legacy: true } }),
    });
    table.put({ pk: 'trace-1', sk: 'RUN#run-1', run: makeRun({ annotation: { legacy: 'run' } }) });

    await expect(adapter.getTrace('trace-1')).resolves.toEqual({
      trace: makeTrace({ annotation: { legacy: true } }),
      runs: [makeRun({ annotation: { legacy: 'run' } })],
    });

    await adapter.patchTraceAnnotation({ traceId: 'trace-1', annotation: {}, merge: false });
    await adapter.patchRunAnnotation({
      traceId: 'trace-1',
      runId: 'run-1',
      annotation: { fresh: 1 },
      merge: false,
    });

    await expect(adapter.getTrace('trace-1')).resolves.toEqual({
      trace: makeTrace(),
      runs: [makeRun({ annotation: { fresh: 1 } })],
    });
  });

  it('returns null when patching a missing trace or run', async () => {
    const table = createFakeTable();
    const adapter = new DynamoStructureStoreAdapter({ tableName: 'traces', client: table.client });
    await adapter.upsertTrace(makeTrace());

    await expect(
      adapter.patchTraceAnnotation({ traceId: 'missing', annotation: { a: 1 } }),
    ).resolves.toBeNull();
    await expect(
      adapter.patchRunAnnotation({ traceId: 'trace-1', runId: 'missing', annotation: { a: 1 } }),
    ).resolves.toBeNull();
    expect(table.size()).toBe(1);
  });

  it('bounds the number of concurrent run writes', async () => {
    const table = createFakeTable({ latencyMs: 2 });
    const adapter = new DynamoStructureStoreAdapter({
      tableName: 'traces',
      client: table.client,
      maxConcurrentWrites: 4,
    });
    const runs = Array.from({ length: 20 }, (_, i) => makeRun({ runId: `run-${i}` }));

    await adapter.upsertRunBatch(runs);

    expect(table.maxInFlight).toBe(4);
    expect(table.size()).toBe(20);
  });
});

type Item = Record<string, unknown>;

function dayIso(day: number, minute = 0): string {
  return new Date(Date.UTC(2026, 0, day, 0, minute)).toISOString();
}

/** Upserts traces `t1..tN` starting on consecutive days and returns their ids, oldest first. */
async function upsertTracesAtDays(
  adapter: DynamoStructureStoreAdapter,
  count: number,
): Promise<string[]> {
  const traceIds = Array.from({ length: count }, (_, i) => `t${i + 1}`);
  for (const [i, traceId] of traceIds.entries()) {
    await adapter.upsertTrace(makeTrace({ traceId, startTime: dayIso(i + 1) }));
  }
  return traceIds;
}

async function collectPages(
  adapter: DynamoStructureStoreAdapter,
  query: { limit: number },
): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await adapter.listTraces({ ...query, cursor });
    pages.push(page.traces.map((trace) => trace.traceId));
    cursor = page.nextCursor;
    if (pages.length > 20) throw new Error('cursor never ended');
  } while (cursor);
  return pages;
}

function startOf(table: { items: () => Item[] }, traceId: string): string {
  const item = table
    .items()
    .find((candidate) => candidate.pk === traceId && candidate.sk === 'TRACE');
  return String(item?.listSk);
}

type FakeTableOptions = {
  /** Max items per Query page, standing in for DynamoDB's 1 MB page limit. */
  pageSize?: number;
  latencyMs?: number;
  /** Runs against the stored item right before each conditional update is evaluated. */
  beforeUpdate?: (item: Item) => void;
};

type Command = { constructor: { name: string }; input: Record<string, unknown> };

const INDEX_KEYS: Record<string, readonly [string, string]> = {
  byStartTime: ['listPk', 'listSk'],
  byProject: ['projectPk', 'listSk'],
};

/** Like DynamoDB, rejects placeholders that are missing or never referenced. */
function assertPlaceholders(
  expressions: (string | undefined)[],
  names: Record<string, string> = {},
  values: Item = {},
): void {
  const text = expressions.filter(Boolean).join(' ');
  const usedNames = new Set(text.match(/#\w+/g));
  const usedValues = new Set(text.match(/:\w+/g));
  for (const name of usedNames) {
    if (!(name in names)) throw new Error(`ValidationException: unknown name ${name}`);
  }
  for (const value of usedValues) {
    if (!(value in values)) throw new Error(`ValidationException: unknown value ${value}`);
  }
  const unused = [
    ...Object.keys(names).filter((name) => !usedNames.has(name)),
    ...Object.keys(values).filter((value) => !usedValues.has(value)),
  ];
  if (unused.length > 0) {
    throw new Error(`ValidationException: unused expression attributes ${unused.join(', ')}`);
  }
}

/**
 * In-memory stand-in for the DynamoDB document client. It evaluates the SET/REMOVE update and
 * condition expressions the adapter sends and, like DynamoDB, rejects unknown or unused
 * expression names and values.
 */
function createFakeTable(options: FakeTableOptions = {}) {
  const items = new Map<string, Item>();
  const keyOf = (key: Item) => `${String(key.pk)}::${String(key.sk)}`;
  const state = { conflicts: 0, inFlight: 0, maxInFlight: 0 };

  const send = vi.fn(async (command: Command) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
      else await Promise.resolve();
      return execute(command);
    } finally {
      state.inFlight -= 1;
    }
  });

  function execute(command: Command): Item {
    const input = command.input;
    switch (command.constructor.name) {
      case 'GetCommand':
        return { Item: clone(items.get(keyOf(input.Key as Item))) };
      case 'PutCommand':
        items.set(keyOf(input.Item as Item), clone(input.Item as Item));
        return {};
      case 'UpdateCommand':
        return update(input);
      case 'QueryCommand':
        return query(input);
      default:
        throw new Error(`Unexpected command: ${command.constructor.name}`);
    }
  }

  function update(input: Item): Item {
    const key = input.Key as Item;
    const existing = items.get(keyOf(key));
    if (existing && options.beforeUpdate) options.beforeUpdate(existing);

    const expressions = new Expressions(
      input.ExpressionAttributeNames as Record<string, string> | undefined,
      input.ExpressionAttributeValues as Item | undefined,
    );
    const next = clone(existing) ?? { ...key };
    expressions.applyUpdate(String(input.UpdateExpression), next);
    const condition = input.ConditionExpression as string | undefined;
    const passes = condition ? expressions.evaluate(condition, existing ?? {}) : true;
    expressions.assertAllUsed();

    if (!passes) {
      state.conflicts += 1;
      throw new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      });
    }

    items.set(keyOf(key), next);
    return input.ReturnValues === 'ALL_NEW' ? { Attributes: clone(next) } : {};
  }

  /** Mirrors DynamoDB: `Limit` caps evaluated items before the filter; indexes are sparse. */
  function query(input: Item): Item {
    const indexName = input.IndexName as string | undefined;
    const keys = indexName ? INDEX_KEYS[indexName] : (['pk', 'sk'] as const);
    if (!keys) throw new Error(`ResourceNotFoundException: no index ${indexName}`);
    const [partitionAttr, sortAttr] = keys;

    const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
    const values = input.ExpressionAttributeValues as Item | undefined;
    const keyCondition = String(input.KeyConditionExpression);
    const filter = input.FilterExpression as string | undefined;
    assertPlaceholders([keyCondition, filter], names, values);
    const expressions = new Expressions(names, values);

    const matches = [...items.values()]
      .filter(
        (item) => item[partitionAttr] !== undefined && expressions.evaluate(keyCondition, item),
      )
      .sort((left, right) => String(left[sortAttr]).localeCompare(String(right[sortAttr])));
    if (input.ScanIndexForward === false) matches.reverse();

    const startKey = input.ExclusiveStartKey as Item | undefined;
    const start = startKey ? matches.findIndex((item) => keyOf(item) === keyOf(startKey)) + 1 : 0;
    const pageLimit = Math.min(
      (input.Limit as number | undefined) ?? Number.POSITIVE_INFINITY,
      options.pageSize ?? Number.POSITIVE_INFINITY,
    );
    const evaluated = matches.slice(start, start + pageLimit);
    const returned = filter
      ? evaluated.filter((item) => expressions.evaluate(filter, item))
      : evaluated;
    const last = evaluated.at(-1);
    const hasMore = start + evaluated.length < matches.length;

    return {
      Items: returned.map((item) => clone(item)),
      ...(hasMore && last
        ? {
            LastEvaluatedKey: {
              pk: last.pk,
              sk: last.sk,
              ...(indexName
                ? { [partitionAttr]: last[partitionAttr], [sortAttr]: last[sortAttr] }
                : {}),
            },
          }
        : {}),
    };
  }

  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    put: (item: Item) => items.set(keyOf(item), clone(item)),
    items: () => [...items.values()],
    size: () => items.size,
    /** Inputs of every command of the given type sent so far. */
    sent: (commandName: string) =>
      send.mock.calls
        .map(([command]) => command)
        .filter((command) => command.constructor.name === commandName)
        .map((command) => command.input),
    get conflicts() {
      return state.conflicts;
    },
    get maxInFlight() {
      return state.maxInFlight;
    },
  };
}

class Expressions {
  private readonly usedNames = new Set<string>();
  private readonly usedValues = new Set<string>();
  private readonly names: Record<string, string>;
  private readonly values: Item;

  constructor(names: Record<string, string> | undefined, values: Item | undefined) {
    if (values !== undefined && Object.keys(values).length === 0) {
      throw new Error('ValidationException: ExpressionAttributeValues must not be empty');
    }
    this.names = names ?? {};
    this.values = values ?? {};
  }

  applyUpdate(expression: string, item: Item): void {
    const clauses = expression.matchAll(/(SET|REMOVE)\s+(.*?)(?=\s+(?:SET|REMOVE)\s+|$)/g);
    for (const [, action, body] of clauses) {
      for (const part of body.split(',').map((value) => value.trim())) {
        if (action === 'SET') {
          const match = /^(\S+)\s*=\s*(:\w+)$/.exec(part);
          if (!match) throw new Error(`Unsupported SET clause: ${part}`);
          this.setPath(item, this.path(match[1]), clone(this.value(match[2])));
        } else {
          this.removePath(item, this.path(part));
        }
      }
    }
  }

  evaluate(expression: string, item: Item): boolean {
    const tokens = expression
      .replace(/(<=|>=|<>|[()=<>])/g, ' $1 ')
      .split(/\s+/)
      .filter(Boolean);
    let index = 0;
    const next = (): string => tokens[index++];
    const expect = (token: string): void => {
      if (next() !== token) throw new Error(`Malformed condition: ${expression}`);
    };

    const primary = (): boolean => {
      const token = next();
      if (token === '(') {
        const result = or();
        expect(')');
        return result;
      }
      if (token === 'attribute_exists' || token === 'attribute_not_exists') {
        expect('(');
        const exists = this.readPath(item, this.path(next())) !== undefined;
        expect(')');
        return token === 'attribute_exists' ? exists : !exists;
      }
      const actual = this.readPath(item, this.path(token));
      const operator = next();
      if (operator === 'BETWEEN') {
        const low = this.value(next()) as string;
        expect('AND');
        const high = this.value(next()) as string;
        return actual !== undefined && (actual as string) >= low && (actual as string) <= high;
      }
      return compare(actual, operator, this.value(next()));
    };
    const and = (): boolean => {
      let result = primary();
      while (tokens[index] === 'AND') {
        index += 1;
        result = primary() && result;
      }
      return result;
    };
    const or = (): boolean => {
      let result = and();
      while (tokens[index] === 'OR') {
        index += 1;
        result = and() || result;
      }
      return result;
    };

    const result = or();
    if (index !== tokens.length) throw new Error(`Malformed condition: ${expression}`);
    return result;
  }

  assertAllUsed(): void {
    const unusedNames = Object.keys(this.names).filter((name) => !this.usedNames.has(name));
    const unusedValues = Object.keys(this.values).filter((value) => !this.usedValues.has(value));
    if (unusedNames.length > 0 || unusedValues.length > 0) {
      throw new Error(
        `ValidationException: unused expression attributes ${[...unusedNames, ...unusedValues].join(', ')}`,
      );
    }
  }

  private path(raw: string): string[] {
    return raw.split('.').map((segment) => {
      if (!segment.startsWith('#')) return segment;
      if (!(segment in this.names)) throw new Error(`ValidationException: unknown name ${segment}`);
      this.usedNames.add(segment);
      return this.names[segment];
    });
  }

  private value(placeholder: string): unknown {
    if (!(placeholder in this.values)) {
      throw new Error(`ValidationException: unknown value ${placeholder}`);
    }
    this.usedValues.add(placeholder);
    return this.values[placeholder];
  }

  private readPath(item: Item, path: string[]): unknown {
    let current: unknown = item;
    for (const segment of path) {
      if (!current || typeof current !== 'object') return undefined;
      current = (current as Item)[segment];
    }
    return current;
  }

  private parent(item: Item, path: string[]): Item {
    const parent = this.readPath(item, path.slice(0, -1));
    if (!parent || typeof parent !== 'object') {
      throw new Error(`ValidationException: invalid document path ${path.join('.')}`);
    }
    return parent as Item;
  }

  private setPath(item: Item, path: string[], value: unknown): void {
    this.parent(item, path)[path.at(-1) as string] = value;
  }

  private removePath(item: Item, path: string[]): void {
    delete this.parent(item, path)[path.at(-1) as string];
  }
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  if (actual === undefined) return operator === '<>';
  const [left, right] = [actual as string, expected as string];
  switch (operator) {
    case '=':
      return left === right;
    case '<>':
      return left !== right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      throw new Error(`Unsupported operator ${operator}`);
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
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
