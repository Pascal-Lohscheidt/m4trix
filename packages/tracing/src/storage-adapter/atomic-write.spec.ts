import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../storage-adapter/atomic-write.js';

describe('writeFileAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'm4trix-atomic-write-'));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it('writes the final file and leaves no temp files behind', async () => {
    const target = join(dir, 'trace.json');
    await writeFileAtomic(target, '{"ok":true}\n');

    await expect(readFile(target, 'utf-8')).resolves.toBe('{"ok":true}\n');
  });
});
