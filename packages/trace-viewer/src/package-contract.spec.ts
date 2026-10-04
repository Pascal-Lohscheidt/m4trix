import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** First @m4trix/tracing release that ships the `@m4trix/tracing/aws` entry. */
const TRACING_AWS_ENTRY_SINCE = { major: 0, minor: 11 };

describe('package contract', () => {
  it('imports the AWS adapters from the @m4trix/tracing/aws entry', async () => {
    const source = await readFile(join(__dirname, 'aws-setup.ts'), 'utf-8');

    expect(source).toContain("from '@m4trix/tracing/aws'");
  });

  it('only accepts @m4trix/tracing releases that ship the aws entry', async () => {
    const { default: pkg } = await import('../package.json');
    const range: string = pkg.peerDependencies['@m4trix/tracing'];

    const match = /^\^(\d+)\.(\d+)\.\d+$/.exec(range);
    expect(match, `expected a caret range, got "${range}"`).not.toBeNull();
    const [major, minor] = [Number(match?.[1]), Number(match?.[2])];
    expect(major).toBe(TRACING_AWS_ENTRY_SINCE.major);
    expect(minor).toBeGreaterThanOrEqual(TRACING_AWS_ENTRY_SINCE.minor);
  });
});
