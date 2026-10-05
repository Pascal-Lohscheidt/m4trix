import { describe, expect, it, vi } from 'vitest';
import pkg from '../package.json';
import * as root from './index.js';

// The root entry must not load the AWS SDK: if it imports any of these, this file fails to load.
// (Static imports with hoisted mocks keep module loading out of the per-test timeout.)
vi.mock('@aws-sdk/client-dynamodb', () => {
  throw new Error('@aws-sdk/client-dynamodb must not be loaded by the root entry');
});
vi.mock('@aws-sdk/client-s3', () => {
  throw new Error('@aws-sdk/client-s3 must not be loaded by the root entry');
});
vi.mock('@aws-sdk/lib-dynamodb', () => {
  throw new Error('@aws-sdk/lib-dynamodb must not be loaded by the root entry');
});

describe('package entry points', () => {
  it('loads the root entry without the AWS SDK', () => {
    expect(root.Tracer).toBeDefined();
    expect(root.FsStructureStoreAdapter).toBeDefined();
    expect(root).not.toHaveProperty('DynamoStructureStoreAdapter');
    expect(root).not.toHaveProperty('S3PayloadStoreAdapter');
  });

  it('publishes the aws entry and keeps the AWS SDK an optional peer', () => {
    expect(pkg.exports['./aws']).toEqual({
      types: './dist/aws.d.ts',
      import: './dist/aws.js',
      require: './dist/aws.cjs',
      default: './dist/aws.js',
    });
    // TypeScript's legacy `moduleResolution: "node"` ignores `exports`; typesVersions covers it.
    expect(pkg.typesVersions).toEqual({ '*': { aws: ['./dist/aws.d.ts'] } });
    const sdks = [
      '@aws-sdk/client-dynamodb',
      '@aws-sdk/client-s3',
      '@aws-sdk/lib-dynamodb',
    ] as const;
    for (const sdk of sdks) {
      expect(
        (pkg as { dependencies?: Record<string, string> }).dependencies?.[sdk],
      ).toBeUndefined();
      expect(pkg.peerDependencies[sdk]).toBeDefined();
      expect(pkg.peerDependenciesMeta[sdk]).toEqual({ optional: true });
    }
  });
});
