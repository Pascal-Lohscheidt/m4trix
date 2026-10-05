import { describe, expect, it } from 'vitest';
import * as aws from './aws.js';

describe('aws entry', () => {
  it('exposes the AWS adapters and their env resolvers', () => {
    expect(Object.keys(aws).sort()).toEqual([
      'DynamoStructureStoreAdapter',
      'S3PayloadStoreAdapter',
      'resolveDynamoStructureStoreOptionsFromEnv',
      'resolveS3PayloadStoreOptionsFromEnv',
    ]);
  });
});
