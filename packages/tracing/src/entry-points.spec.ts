import { describe, expect, it, vi } from 'vitest';

// Any import of the AWS SDK from the root entry fails the test.
for (const sdk of ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3', '@aws-sdk/lib-dynamodb']) {
  vi.doMock(sdk, () => {
    throw new Error(`${sdk} must not be loaded by the root entry`);
  });
}

describe('package entry points', () => {
  it('loads the root entry without the AWS SDK', async () => {
    const root = await import('./index.js');

    expect(root.Tracer).toBeDefined();
    expect(root.FsStructureStoreAdapter).toBeDefined();
    expect(root).not.toHaveProperty('DynamoStructureStoreAdapter');
    expect(root).not.toHaveProperty('S3PayloadStoreAdapter');
  });

  it('exposes the AWS adapters from the aws entry', async () => {
    vi.resetModules();
    for (const sdk of ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3', '@aws-sdk/lib-dynamodb']) {
      vi.doUnmock(sdk);
    }

    const aws = await import('./aws.js');

    expect(Object.keys(aws).sort()).toEqual([
      'DynamoStructureStoreAdapter',
      'S3PayloadStoreAdapter',
      'resolveDynamoStructureStoreOptionsFromEnv',
      'resolveS3PayloadStoreOptionsFromEnv',
    ]);
  });

  it('publishes the aws entry and keeps the AWS SDK an optional peer', async () => {
    const { default: pkg } = await import('../package.json');

    expect(pkg.exports['./aws']).toEqual({
      types: './dist/aws.d.ts',
      import: './dist/aws.js',
      require: './dist/aws.cjs',
      default: './dist/aws.js',
    });
    for (const sdk of ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3', '@aws-sdk/lib-dynamodb']) {
      expect(pkg.dependencies?.[sdk]).toBeUndefined();
      expect(pkg.peerDependencies[sdk]).toBeDefined();
      expect(pkg.peerDependenciesMeta[sdk]).toEqual({ optional: true });
    }
  });
});
