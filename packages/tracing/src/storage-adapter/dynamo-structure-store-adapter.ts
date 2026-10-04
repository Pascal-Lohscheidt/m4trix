/**
 * DynamoDB single-table layout for trace structure storage.
 *
 * Table (name from `TRACE_DYNAMO_TABLE` or options):
 * - pk (S): traceId
 * - sk (S): `TRACE` | `RUN#<runId>`
 *
 * GSI `byStartTime` (name configurable, default `byStartTime`):
 * - listPk (S): `PROJECT#_all` on trace items
 * - listSk (S): trace.startTime (ISO-8601)
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
};

const TRACE_SK = 'TRACE';
const LIST_PK_ALL = 'PROJECT#_all';
const DEFAULT_MAX_CONCURRENT_WRITES = 16;
const MAX_ANNOTATION_ATTEMPTS = 5;

type Item = Record<string, unknown>;
type RecordAttribute = 'trace' | 'run';

export class DynamoStructureStoreAdapter implements StructureStoreAdapter {
  private readonly tableName: string;
  private readonly startTimeIndexName: string;
  private readonly maxConcurrentWrites: number;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoStructureStoreAdapterOptions) {
    this.tableName = options.tableName;
    this.startTimeIndexName = options.startTimeIndexName ?? 'byStartTime';
    this.maxConcurrentWrites = Math.max(
      1,
      options.maxConcurrentWrites ?? DEFAULT_MAX_CONCURRENT_WRITES,
    );
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
      listPk: LIST_PK_ALL,
      listSk: trace.startTime,
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
    const params: QueryCommandInput = {
      TableName: this.tableName,
      IndexName: this.startTimeIndexName,
      KeyConditionExpression: 'listPk = :listPk',
      ExpressionAttributeValues: { ':listPk': LIST_PK_ALL },
      ScanIndexForward: false,
    };

    const filters: string[] = [];
    if (query.projectId) {
      filters.push('trace.projectId = :projectId');
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ':projectId': query.projectId,
      };
    }
    if (query.status) {
      filters.push('trace.#status = :status');
      params.ExpressionAttributeNames = {
        ...(params.ExpressionAttributeNames ?? {}),
        '#status': 'status',
      };
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ':status': query.status,
      };
    }
    if (query.startAfter) {
      filters.push('trace.startTime > :startAfter');
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ':startAfter': query.startAfter,
      };
    }
    if (query.startBefore) {
      filters.push('trace.startTime < :startBefore');
      params.ExpressionAttributeValues = {
        ...params.ExpressionAttributeValues,
        ':startBefore': query.startBefore,
      };
    }
    if (filters.length > 0) {
      params.FilterExpression = filters.join(' AND ');
    }

    if (query.cursor) {
      const startKey = decodeCursor(query.cursor);
      if (startKey) params.ExclusiveStartKey = startKey;
    }

    const limit = query.limit && query.limit > 0 ? query.limit : undefined;
    const traces: Trace[] = [];
    let lastEvaluatedKey = params.ExclusiveStartKey;

    while (limit === undefined || traces.length < limit) {
      const page = await this.client.send(
        new QueryCommand({
          ...params,
          ExclusiveStartKey: lastEvaluatedKey,
          ...(limit !== undefined ? { Limit: limit - traces.length } : {}),
        }),
      );

      for (const item of page.Items ?? []) {
        if (item.trace) traces.push(readRecord<Trace>(item, 'trace'));
      }

      lastEvaluatedKey = page.LastEvaluatedKey;
      if (!lastEvaluatedKey || (limit !== undefined && traces.length >= limit)) break;
    }

    return {
      traces,
      ...(lastEvaluatedKey ? { nextCursor: encodeCursor(lastEvaluatedKey) } : {}),
    };
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

  /** Writes the record document (and an explicit annotation, if given) without touching others. */
  private async upsertRecord(
    key: Item,
    attribute: RecordAttribute,
    record: Item,
    annotation: TraceAnnotation | undefined,
    extra: Item = {},
  ): Promise<void> {
    const expression = new UpdateExpressionBuilder();
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

      const expression = new UpdateExpressionBuilder();
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
class UpdateExpressionBuilder {
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

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
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
    tableName,
    region: overrides.region ?? process.env.AWS_REGION,
    endpoint: overrides.endpoint ?? process.env.AWS_ENDPOINT_URL,
    startTimeIndexName: overrides.startTimeIndexName,
    client: overrides.client,
  };
}
