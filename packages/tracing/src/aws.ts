/**
 * AWS storage adapters (DynamoDB structure + S3 payloads). Kept out of the root entry so that
 * using the tracer does not load the AWS SDK; install the `@aws-sdk/*` peer dependencies to use it.
 */
export {
  DynamoStructureStoreAdapter,
  type DynamoStructureStoreAdapterOptions,
  resolveDynamoStructureStoreOptionsFromEnv,
} from './storage-adapter/dynamo-structure-store-adapter.js';
export {
  resolveS3PayloadStoreOptionsFromEnv,
  S3PayloadStoreAdapter,
  type S3PayloadStoreAdapterOptions,
} from './storage-adapter/s3-payload-store-adapter.js';
