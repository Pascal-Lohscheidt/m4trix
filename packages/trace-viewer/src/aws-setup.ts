import {
  DynamoStructureStoreAdapter,
  resolveDynamoStructureStoreOptionsFromEnv,
  resolveS3PayloadStoreOptionsFromEnv,
  S3PayloadStoreAdapter,
  TraceStore,
  TraceViewerApi,
} from '@m4trix/tracing';

export type AwsStackTraceViewerOptions = {
  dynamoTable?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  region?: string;
  endpoint?: string;
};

export function createAwsStackTraceViewerApi(
  options: AwsStackTraceViewerOptions = {},
): TraceViewerApi {
  const traceStore = TraceStore.of({
    structureStoreAdapter: new DynamoStructureStoreAdapter(
      resolveDynamoStructureStoreOptionsFromEnv({
        tableName: options.dynamoTable,
        region: options.region,
        endpoint: options.endpoint,
      }),
    ),
    payloadStoreAdapter: new S3PayloadStoreAdapter(
      resolveS3PayloadStoreOptionsFromEnv({
        bucket: options.s3Bucket,
        prefix: options.s3Prefix,
        region: options.region,
        endpoint: options.endpoint,
      }),
    ),
  });
  return TraceViewerApi.from(traceStore);
}
