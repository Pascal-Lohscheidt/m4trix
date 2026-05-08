import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsPayloadStoreAdapter } from './index.js';

describe('FsPayloadStoreAdapter', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'm4trix-tracing-payloads-'));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('writes and reads JSON payloads under the configured root', async () => {
    const adapter = new FsPayloadStoreAdapter({ path: root });

    const ref = await adapter.putJson('traces/trace-1/payloads/run-1/input.json', {
      question: 'hello',
    });

    await expect(adapter.getJson(ref)).resolves.toEqual({ question: 'hello' });
    await expect(readFile(join(root, ref), 'utf-8')).resolves.toBe(
      `${JSON.stringify({ question: 'hello' }, null, 2)}\n`,
    );
  });

  it('writes and reads byte streams for NDJSON event payloads', async () => {
    const adapter = new FsPayloadStoreAdapter({ path: root });
    const encoder = new TextEncoder();

    const ref = await adapter.putStream('traces/trace-1/payloads/run-1/events.ndjson', [
      encoder.encode('{"event":"start"}\n'),
      encoder.encode('{"event":"end"}\n'),
    ]);

    const stream = await adapter.getStream(ref);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();

    while (true) {
      const read = await reader.read();
      if (read.done) break;
      chunks.push(read.value);
    }

    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(
      '{"event":"start"}\n{"event":"end"}\n',
    );
  });

  it('rejects path traversal attempts', async () => {
    const adapter = new FsPayloadStoreAdapter({ path: root });

    await expect(adapter.putJson('../outside.json', {})).rejects.toThrow('relative path');
    await expect(adapter.getJson('/tmp/outside.json')).rejects.toThrow('relative ref');
  });
});
