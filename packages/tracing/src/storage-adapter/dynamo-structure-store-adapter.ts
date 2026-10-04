/**
 * DynamoDB single-table layout for trace structure storage.
 *
 * Table (name from `TRACE_DYNAMO_TABLE` or options):
 * - pk (S): traceId
 * - sk (S): `TRACE` | `RUN#<runId>`
 *
 * GSI `byStartTime` (name configurable, default `byStartTime`):
 * - listPk (S): `PROJECT#_all` on trace items, or `PROJECT#_all#<n>` when `listShards` > 1 spreads
 *   trace writes over n partitions (reads query every shard plus the unsharded key and merge)
 * - listSk (S): trace.startTime (ISO-8601)
 *
 * Optional GSI for per-project listing (set `projectIndexName`):
 * - projectPk (S): `PROJECT#<projectId>`, written on every trace item that has a project
 * - listSk (S): trace.startTime
 *
 * Trace items store the `Trace` document under attribute `trace`.
 * Run items store the `TraceRun` document under attribute `run`.
 *
 * Annotations live in a separate top-level `annotation` attribute next to `trace` / `run`, with an
 * `annotationVersion` counter. Ingest upserts only SET `trace` / `run`, so re-shipping a trace
 * never touches review annotations; patches are version-checked to avoid lost updates. Items
 * written before this layout kept the annotation inside `trace` / `run`; reads fall back to it and
 * the next patch moves it out.
 */
import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mergeTraceAnnotation } from '../annotation-merge.js';
import type {
  ListTracesQuery,
  ListTracesResult,
  PatchRunAnnotationInput,
  PatchTraceAnnotationInput,
  StructureStoreAdapter,
  Trace,
  TraceAnnotation,
  TraceRecord,
  TraceRun,
} from '../types.js';

export type DynamoStructureStoreAdapterOptions = {
  tableName: string;
  region?: string;
  endpoint?: string;
  startTimeIndexName?: string;
  client?: DynamoDBDocumentClient;
  /** Max run writes in flight per batch (default 16). */
  maxConcurrentWrites?: number;
  /**
   * Spread trace items over this many `byStartTime` partitions (default 1) to avoid a hot key at
   * high trace volume. Listing then queries every shard and merges, newest first.
   */
  listShards?: number;
  /** GSI on `projectPk` + `listSk`; when set, `projectId` queries use it instead of a filter. */
  projectIndexName?: string;
};

const TRACE_SK = 'TRACE';
const LIST_PK_ALL = 'PROJECT#_all';
const DEFAULT_MAX_CONCURRENT_WRITES = 16;
const MAX_ANNOTATION_ATTEMPTS = 5;

type Item = Record<string, unknown>;
type RecordAttribute = 'trace' | 'run';

/** One index partition that `listTraces` reads from. */
type ListSource = {
  indexName: string;
  partitionAttribute: 'listPk' | 'projectPk';
  partitionKey: string;
};

/** Per list partition: the key to resume after, or `null` once that partition is exhausted. */
type ListCursor = Record<string, Item | null>;

export class DynamoStructureStoreAdapter implements StructureStoreAdapter {
  private readonly tableName: string;
  private readonly startTimeIndexName: string;
  private readonly maxConcurrentWrites: number;
  private readonly listShards: number;
  private readonly projectIndexName: string | undefined;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoStructureStoreAdapterOptions) {
    this.tableName = options.tableName;
    this.startTimeIndexName = options.startTimeIndexName ?? 'byStartTime';
    this.maxConcurrentWrites = Math.max(
      1,
      options.maxConcurrentWrites ?? DEFAULT_MAX_CONCURRENT_WRITES,
    );
    this.listShards = Math.max(1, Math.floor(options.listShards ?? 1));
    this.projectIndexName = options.projectIndexName;
    this.client =
      options.client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: options.region ?? process.env.AWS_REGION,
          endpoint: options.endpoint ?? process.env.AWS_ENDPOINT_URL,
        } satisfies DynamoDBClientConfig),
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }

  async upsertTrace(trace: Trace): Promise<void> {
    const { annotation, ...record } = trace;
    await this.upsertRecord({ pk: trace.traceId, sk: TRACE_SK }, 'trace', record, annotation, {
      listPk: this.listKeyFor(trace.traceId),
      listSk: trace.startTime,
      ...(trace.projectId ? { projectPk: projectKey(trace.projectId) } : {}),
    });
  }

  async upsertRun(run: TraceRun): Promise<void> {
    await this.upsertRunBatch([run]);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    await forEachConcurrently(runs, this.maxConcurrentWrites, async (run) => {
      const { annotation, ...record } = run;
      await this.upsertRecord({ pk: run.traceId, sk: runSk(run.runId) }, 'run', record, annotation);
    });
  }

  async getTrace(traceId: string): Promise<TraceRecord | null> {
    const items: Item[] = [];
    let exclusiveStartKey: Item | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': traceId },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);

    let trace: Trace | undefined;
    const runs: TraceRun[] = [];
    for (const item of items) {
      if (item.sk === TRACE_SK && item.trace) {
        trace = readRecord<Trace>(item, 'trace');
      } else if (typeof item.sk === 'string' && item.sk.startsWith('RUN#') && item.run) {
        runs.push(readRecord<TraceRun>(item, 'run'));
      }
    }

    if (!trace) return null;
    return { trace, runs };
  }

  async listTraces(query: ListTracesQuery = {}): Promise<ListTracesResult> {
    const cursor = decodeCursor(query.cursor, this.listSources(query));
    const sources = this.listSources(query).filter(
      (source) => cursor[source.partitionKey] !== null,
    );
    const streams = sources.map(
      (source) =>
        new ListStream(
          this.client,
          this.listQuery(source, query),
          ['pk', 'sk', source.partitionAttribute, 'listSk'],
          cursor[source.partitionKey] ?? undefined,
        ),
    );

    const limit = query.limit && query.limit > 0 ? query.limit : undefined;
    const traces: Trace[] = [];
    while (limit === undefined || traces.length < limit) {
      const remaining = limit === undefined ? undefined : limit - traces.length;
      const heads = await Promise.all(streams.map((stream) => stream.peek(remaining)));
      let newest: number | undefined;
      heads.forEach((head, index) => {
        if (!head) return;
        if (newest === undefined || String(head.listSk) > String(heads[newest]?.listSk)) {
          newest = index;
        }
      });
      if (newest === undefined) break;
      traces.push(readRecord<Trace>(streams[newest].take(), 'trace'));
    }

    if (streams.every((stream) => stream.done)) return { traces };

    // Partitions finished on an earlier page stay finished; others resume after what was returned.
    const next: ListCursor = { ...cursor };
    sources.forEach((source, index) => {
      const stream = streams[index];
      const resumeKey = stream.resumeKey;
      if (stream.done) next[source.partitionKey] = null;
      else if (resumeKey) next[source.partitionKey] = resumeKey;
    });
    return { traces, nextCursor: encodeCursor(next) };
  }

  async patchTraceAnnotation(input: PatchTraceAnnotationInput): Promise<Trace | null> {
    return this.patchAnnotation<Trace>({ pk: input.traceId, sk: TRACE_SK }, 'trace', input);
  }

  async patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    return this.patchAnnotation<TraceRun>(
      { pk: input.traceId, sk: runSk(input.runId) },
      'run',
      input,
    );
  }

  private listKeyFor(traceId: string): string {
    return this.listShards === 1
      ? LIST_PK_ALL
      : `${LIST_PK_ALL}#${shardOf(traceId, this.listShards)}`;
  }

  private listSources(query: ListTracesQuery): ListSource[] {
    if (query.projectId && this.projectIndexName) {
      return [
        {
          indexName: this.projectIndexName,
          partitionAttribute: 'projectPk',
          partitionKey: projectKey(query.projectId),
        },
      ];
    }

    // The unsharded key is always read so traces written before sharding stay listed.
    const keys = [LIST_PK_ALL];
    if (this.listShards > 1) {
      for (let shard = 0; shard < this.listShards; shard++) keys.push(`${LIST_PK_ALL}#${shard}`);
    }
    return keys.map((partitionKey) => ({
      indexName: this.startTimeIndexName,
      partitionAttribute: 'listPk',
      partitionKey,
    }));
  }

  private listQuery(source: ListSource, query: ListTracesQuery): QueryCommandInput {
    const expression = new ExpressionBuilder();
    const keyConditions = [
      `${expression.name(source.partitionAttribute)} = ${expression.value(source.partitionKey)}`,
    ];
    const filters: string[] = [];
    const traceField = (field: string): string =>
      `${expression.name('trace')}.${expression.name(field)}`;

    const after = query.startAfter ? expression.value(query.startAfter) : undefined;
    const before = query.startBefore ? expression.value(query.startBefore) : undefined;
    if (after && before) {
      // BETWEEN is inclusive; the filter keeps both bounds exclusive.
      keyConditions.push(`${expression.name('listSk')} BETWEEN ${after} AND ${before}`);
      filters.push(
        `${traceField('startTime')} > ${after}`,
        `${traceField('startTime')} < ${before}`,
      );
    } else if (after) {
      keyConditions.push(`${expression.name('listSk')} > ${after}`);
    } else if (before) {
      keyConditions.push(`${expression.name('listSk')} < ${before}`);
    }

    if (query.projectId && source.partitionAttribute !== 'projectPk') {
      filters.push(`${traceField('projectId')} = ${expression.value(query.projectId)}`);
    }
    if (query.status) {
      filters.push(`${traceField('status')} = ${expression.value(query.status)}`);
    }

    return {
      TableName: this.tableName,
      IndexName: source.indexName,
      KeyConditionExpression: keyConditions.join(' AND '),
      ...(filters.length > 0 ? { FilterExpression: filters.join(' AND ') } : {}),
      ScanIndexForward: false,
      ...expression.attributes(),
    };
  }

  /** Writes the record document (and an explicit annotation, if given) without touching others. */
  private async upsertRecord(
    key: Item,
    attribute: RecordAttribute,
    record: Item,
    annotation: TraceAnnotation | undefined,
    extra: Item = {},
  ): Promise<void> {
    const expression = new ExpressionBuilder();
    const assignments = Object.entries({
      [attribute]: record,
      ...extra,
      ...(annotation === undefined ? {} : { annotation }),
    }).map(([name, value]) => `${expression.name(name)} = ${expression.value(value)}`);

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ...expression.attributes(),
      }),
    );
  }

  /** Read-merge-write guarded by `annotationVersion`; retries when another writer got there first. */
  private async patchAnnotation<T extends Trace | TraceRun>(
    key: Item,
    attribute: RecordAttribute,
    input: { annotation: TraceAnnotation; merge?: boolean },
  ): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_ANNOTATION_ATTEMPTS; attempt++) {
      const { Item: item } = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
      );
      if (!item?.[attribute]) return null;

      const version = typeof item.annotationVersion === 'number' ? item.annotationVersion : 0;
      const annotation = mergeTraceAnnotation(
        readRecord<T>(item, attribute).annotation,
        input.annotation,
        input.merge ?? true,
      );

      const expression = new ExpressionBuilder();
      const annotationName = expression.name('annotation');
      const versionName = expression.name('annotationVersion');
      const set = [`${versionName} = ${expression.value(version + 1)}`];
      // Also drop any legacy annotation stored inside the record document.
      const remove = [`${expression.name(attribute)}.${annotationName}`];
      if (annotation === undefined) remove.push(annotationName);
      else set.push(`${annotationName} = ${expression.value(annotation)}`);
      const versionCondition =
        version === 0
          ? `attribute_not_exists(${versionName})`
          : `${versionName} = ${expression.value(version)}`;

      try {
        const result = await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: key,
            UpdateExpression: `SET ${set.join(', ')} REMOVE ${remove.join(', ')}`,
            ConditionExpression: `attribute_exists(${expression.name('pk')}) AND ${versionCondition}`,
            ReturnValues: 'ALL_NEW',
            ...expression.attributes(),
          }),
        );
        return result.Attributes ? readRecord<T>(result.Attributes, attribute) : null;
      } catch (error) {
        if (!isConditionalCheckFailed(error)) throw error;
      }
    }

    throw new Error(
      `Annotation update for ${String(key.pk)}/${String(key.sk)} kept conflicting with concurrent writes after ${MAX_ANNOTATION_ATTEMPTS} attempts`,
    );
  }
}

/** Collects `#name` / `:value` placeholders so expressions never collide with reserved words. */
class ExpressionBuilder {
  private readonly names: Record<string, string> = {};
  private readonly values: Record<string, unknown> = {};

  name(attribute: string): string {
    const placeholder = `#${attribute}`;
    this.names[placeholder] = attribute;
    return placeholder;
  }

  value(value: unknown): string {
    const placeholder = `:v${Object.keys(this.values).length}`;
    this.values[placeholder] = value;
    return placeholder;
  }

  attributes(): {
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  } {
    return {
      ExpressionAttributeNames: this.names,
      ...(Object.keys(this.values).length > 0 ? { ExpressionAttributeValues: this.values } : {}),
    };
  }
}

/** Rebuilds a record with its annotation from the top-level attribute (or the legacy location). */
function readRecord<T extends Trace | TraceRun>(item: Item, attribute: RecordAttribute): T {
  const { annotation: legacyAnnotation, ...record } = item[attribute] as T;
  const annotation = (item.annotation as TraceAnnotation | undefined) ?? legacyAnnotation;
  return (annotation === undefined ? record : { ...record, annotation }) as T;
}

function runSk(runId: string): string {
  return `RUN#${runId}`;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

async function forEachConcurrently<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Reads one list partition page by page, newest first, handing out one trace item at a time. */
class ListStream {
  private readonly buffer: Item[] = [];
  private nextStartKey: Item | undefined;
  private exhausted = false;
  private lastTaken: Item | undefined;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly input: QueryCommandInput,
    private readonly keyAttributes: string[],
    private readonly startKey: Item | undefined,
  ) {
    this.nextStartKey = startKey;
  }

  /** Next item without consuming it; fetches pages (of up to `limit` evaluated items) as needed. */
  async peek(limit?: number): Promise<Item | undefined> {
    while (this.buffer.length === 0 && !this.exhausted) {
      const page = await this.client.send(
        new QueryCommand({
          ...this.input,
          ExclusiveStartKey: this.nextStartKey,
          ...(limit !== undefined ? { Limit: limit } : {}),
        }),
      );
      this.buffer.push(...(page.Items ?? []).filter((item) => item.trace));
      this.nextStartKey = page.LastEvaluatedKey;
      this.exhausted = !page.LastEvaluatedKey;
    }
    return this.buffer[0];
  }

  take(): Item {
    const item = this.buffer.shift();
    if (!item) throw new Error('ListStream.take() called without a peeked item');
    this.lastTaken = item;
    return item;
  }

  get done(): boolean {
    return this.exhausted && this.buffer.length === 0;
  }

  /** Where the next page resumes: right after the last item handed out. */
  get resumeKey(): Item | undefined {
    const item = this.lastTaken;
    if (!item) return this.startKey;
    return Object.fromEntries(this.keyAttributes.map((attribute) => [attribute, item[attribute]]));
  }
}

function projectKey(projectId: string): string {
  return `PROJECT#${projectId}`;
}

/** Stable FNV-1a hash of the trace id, so a trace always lands in the same shard. */
function shardOf(traceId: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < traceId.length; index++) {
    hash ^= traceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shards;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify({ v: 2, after: cursor }), 'utf-8').toString('base64url');
}

/** Cursors from before sharding were a bare LastEvaluatedKey for the single list partition. */
function decodeCursor(cursor: string | undefined, sources: ListSource[]): ListCursor {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Item;
    if (parsed.v === 2 && parsed.after && typeof parsed.after === 'object') {
      return parsed.after as ListCursor;
    }
    return sources.length === 1 ? { [sources[0].partitionKey]: parsed } : {};
  } catch {
    return {};
  }
}

export function resolveDynamoStructureStoreOptionsFromEnv(
  overrides: Partial<DynamoStructureStoreAdapterOptions> = {},
): DynamoStructureStoreAdapterOptions {
  const tableName = overrides.tableName ?? process.env.TRACE_DYNAMO_TABLE;
  if (!tableName) {
    throw new Error('TRACE_DYNAMO_TABLE is required for DynamoStructureStoreAdapter');
  }

  return {
    ...overrides,
    tableName,
    region: overrides.region ?? process.env.AWS_REGION,
    endpoint: overrides.endpoint ?? process.env.AWS_ENDPOINT_URL,
    listShards: overrides.listShards ?? parseListShards(process.env.TRACE_DYNAMO_LIST_SHARDS),
    projectIndexName:
      overrides.projectIndexName ?? (process.env.TRACE_DYNAMO_PROJECT_INDEX || undefined),
  };
}

function parseListShards(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const shards = Number(value);
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`TRACE_DYNAMO_LIST_SHARDS must be a positive integer, got "${value}"`);
  }
  return shards;
}
