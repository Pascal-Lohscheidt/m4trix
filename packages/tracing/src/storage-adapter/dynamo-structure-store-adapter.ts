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
 * Trace items store the full `Trace` document under attribute `trace`.
 * Run items store the full `TraceRun` document under attribute `run`.
 */
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { mergeTraceAnnotation } from '../annotation-merge.js';
import type {
  ListTracesQuery,
  ListTracesResult,
  PatchRunAnnotationInput,
  PatchTraceAnnotationInput,
  StructureStoreAdapter,
  Trace,
  TraceRecord,
  TraceRun,
} from '../types.js';

export type DynamoStructureStoreAdapterOptions = {
  tableName: string;
  region?: string;
  endpoint?: string;
  startTimeIndexName?: string;
  client?: DynamoDBDocumentClient;
};

const TRACE_SK = 'TRACE';
const LIST_PK_ALL = 'PROJECT#_all';

export class DynamoStructureStoreAdapter implements StructureStoreAdapter {
  private readonly tableName: string;
  private readonly startTimeIndexName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoStructureStoreAdapterOptions) {
    this.tableName = options.tableName;
    this.startTimeIndexName = options.startTimeIndexName ?? 'byStartTime';
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
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: traceItem(trace),
      }),
    );
  }

  async upsertRun(run: TraceRun): Promise<void> {
    await this.upsertRunBatch([run]);
  }

  async upsertRunBatch(runs: TraceRun[]): Promise<void> {
    await Promise.all(
      runs.map((run) =>
        this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: runItem(run),
          }),
        ),
      ),
    );
  }

  async getTrace(traceId: string): Promise<TraceRecord | null> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': traceId },
      }),
    );

    const items = result.Items ?? [];
    if (items.length === 0) return null;

    let trace: Trace | undefined;
    const runs: TraceRun[] = [];
    for (const item of items) {
      if (item.sk === TRACE_SK && item.trace) {
        trace = item.trace as Trace;
      } else if (typeof item.sk === 'string' && item.sk.startsWith('RUN#') && item.run) {
        runs.push(item.run as TraceRun);
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
      params.ExpressionAttributeNames = { ...(params.ExpressionAttributeNames ?? {}), '#status': 'status' };
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
        if (item.trace) traces.push(item.trace as Trace);
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
    const record = await this.getTrace(input.traceId);
    if (!record) return null;

    const annotation = mergeTraceAnnotation(
      record.trace.annotation,
      input.annotation,
      input.merge ?? true,
    );
    const trace: Trace = { ...record.trace, annotation };
    if (annotation === undefined) delete trace.annotation;

    await this.upsertTrace(trace);
    return trace;
  }

  async patchRunAnnotation(input: PatchRunAnnotationInput): Promise<TraceRun | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: input.traceId, sk: runSk(input.runId) },
      }),
    );

    const existing = result.Item?.run as TraceRun | undefined;
    if (!existing) return null;

    const annotation = mergeTraceAnnotation(existing.annotation, input.annotation, input.merge ?? true);
    const run: TraceRun = { ...existing, annotation };
    if (annotation === undefined) delete run.annotation;

    await this.upsertRun(run);
    return run;
  }
}

function traceItem(trace: Trace): Record<string, unknown> {
  return {
    pk: trace.traceId,
    sk: TRACE_SK,
    listPk: LIST_PK_ALL,
    listSk: trace.startTime,
    trace,
  };
}

function runItem(run: TraceRun): Record<string, unknown> {
  return {
    pk: run.traceId,
    sk: runSk(run.runId),
    run,
  };
}

function runSk(runId: string): string {
  return `RUN#${runId}`;
}

function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<string, unknown>;
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
