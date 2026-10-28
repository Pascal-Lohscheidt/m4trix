// @vitest-environment node
import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentNetworkStoreKey, StoredEvent } from '@m4trix/core';
import { runStoreContract } from '@m4trix/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openFileNetworkStore } from './file-store.js';

// The real `open`, unless a test hands the store handles that write in parts (see `shortWrites`).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
  .open;
afterEach(() => {
  vi.mocked(open).mockImplementation(realOpen);
});

/**
 * From now on, the store's file handles write at most `max` bytes per `write` call, as the OS may
 * (a short write): the rest is the caller's to write.
 */
const shortWrites = (max: number) =>
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await realOpen(...args);
    const write = (data: Uint8Array | string, offset = 0, length?: number) => {
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      const start = typeof data === 'string' ? 0 : offset;
      const size = length ?? bytes.length - start;
      return handle.write(bytes, start, Math.min(size, max));
    };
    return new Proxy(handle, {
      get: (target, property) =>
        property === 'write' ? write : Reflect.get(target, property, target)?.bind?.(target),
    });
  });

let root: string;
let files = 0;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'm4trix-code-store-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** A file of its own per call, in a directory of its own. */
const freshFile = async (): Promise<string> => {
  const dir = join(root, `store-${files++}`);
  await mkdir(dir);
  return join(dir, 'events.jsonl');
};

runStoreContract({ describe, it, expect }, async () => openFileNetworkStore(await freshFile()));

const key: AgentNetworkStoreKey = { namespace: 'anonymous', contextId: 'ctx-1' };
const other: AgentNetworkStoreKey = { namespace: 'anonymous', contextId: 'ctx-2' };

const event = (runId: string, name: string, payload: unknown = { name }): StoredEvent => ({
  name,
  meta: { runId, contextId: 'ctx-1', eventId: `${runId}:${name}`, ts: 1, depth: 0 },
  payload,
  channels: ['client'],
});

const names = (events: readonly StoredEvent[]) => events.map((stored) => stored.name);

describe('file store', () => {
  it('a new instance on the same file reads the same history, and earlier cursors still work', async () => {
    const file = await freshFile();
    const first = await openFileNetworkStore(file);
    await first.append(key, event('run-1', 'a'));
    await first.append(other, event('run-1', 'x'));
    await first.append(key, event('run-1', 'b'));
    const { head } = await first.readContext(key);
    await first.append(key, event('run-2', 'c'));

    // As after a restart: nothing shared with the first instance but the file.
    const second = await openFileNetworkStore(file);
    expect(await second.readContext(key)).toEqual(await first.readContext(key));
    expect(names(await second.readRun(key, 'run-1'))).toEqual(['a', 'b']);
    expect(names((await second.readContext(other)).events)).toEqual(['x']);
    // A cursor handed out before the restart (e.g. a checkpoint's `through`) is a position in
    // the reopened history, not a reset.
    expect(head).toBe('jsonl:2');
    expect(await second.readContext(key, { after: head })).toEqual({
      events: [event('run-2', 'c')],
      head: 'jsonl:3',
    });
  });

  it('concurrent appends are in the file in the order they became visible', async () => {
    const file = await freshFile();
    const store = await openFileNetworkStore(file);
    // Different runs of one context append at once; large payloads make the writes take a while.
    const big = 'x'.repeat(200_000);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.append(key, event(`run-${index}`, `e${index}`, { big: index % 3 === 0 ? big : '' })),
      ),
    );

    const live = names((await store.readContext(key)).events);
    const reopened = names((await (await openFileNetworkStore(file)).readContext(key)).events);
    // Same order after a restart, so every cursor handed out still points at the same event.
    expect(reopened).toEqual(live);
    expect(live).toEqual(Array.from({ length: 12 }, (_, index) => `e${index}`));
  });

  it('a short write is continued until the whole line is written', async () => {
    const file = await freshFile();
    const store = await openFileNetworkStore(file);
    shortWrites(7);
    const appended = event('run-1', 'a', { text: 'grüße, 你好 ✓' });
    await store.append(key, appended);
    await store.append(key, event('run-1', 'b'));

    // Acknowledged means on disk, whole: a restart reads both.
    vi.mocked(open).mockImplementation(realOpen);
    const reopened = await openFileNetworkStore(file);
    expect((await reopened.readContext(key)).events).toEqual([appended, event('run-1', 'b')]);
  });

  it('a write that takes nothing fails the append instead of trying for ever', async () => {
    const store = await openFileNetworkStore(await freshFile());
    shortWrites(0);
    await expect(store.append(key, event('run-1', 'a'))).rejects.toThrow(
      'the write made no progress',
    );
  });

  it('reads return fresh, unfrozen objects, as a database does', async () => {
    const store = await openFileNetworkStore(await freshFile());
    const appended = Object.freeze(
      event('run-1', 'a', Object.freeze({ list: Object.freeze([1]) })),
    );
    await store.append(key, appended);

    const [read] = (await store.readContext(key)).events;
    const [again] = await store.readRun(key, 'run-1');
    expect(read).toEqual(appended);
    expect(read).not.toBe(appended);
    expect(read).not.toBe(again);
    expect(Object.isFrozen(read)).toBe(false);
    expect(Object.isFrozen(read?.payload)).toBe(false);
    // Changing what a read returned changes nothing stored.
    (read?.payload as { list: number[] }).list.push(2);
    expect((await store.readContext(key)).events).toEqual([appended]);
  });

  it('keeps one JSON line per event, with its key', async () => {
    const file = await freshFile();
    const store = await openFileNetworkStore(file);
    await store.append(key, event('run-1', 'a'));
    await store.append(other, event('run-1', 'x'));

    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual([
      { namespace: 'anonymous', contextId: 'ctx-1', event: event('run-1', 'a') },
      { namespace: 'anonymous', contextId: 'ctx-2', event: event('run-1', 'x') },
    ]);
  });

  it('a cursor past the end of the history, or of another format, reads as a reset', async () => {
    const store = await openFileNetworkStore(await freshFile());
    await store.append(key, event('run-1', 'a'));

    for (const after of ['jsonl:9', '1', '0:1', 'jsonl:-1', 'jsonl:1x']) {
      expect(await store.readContext(key, { after })).toEqual({
        events: [event('run-1', 'a')],
        head: 'jsonl:1',
        reset: true,
      });
    }
    expect(await store.readContext(key, { before: 'jsonl:9' })).toEqual({ events: [] });
  });

  it('a torn last line (a crash during an append) is dropped on open; appends go on after it', async () => {
    const file = await freshFile();
    const first = await openFileNetworkStore(file);
    await first.append(key, event('run-1', 'a'));
    // A crash in the middle of writing the next line: no newline, not all of its JSON.
    const torn = JSON.stringify({
      namespace: 'anonymous',
      contextId: 'ctx-1',
      event: event('run-1', 'b'),
    });
    await appendFile(file, torn.slice(0, 40));

    const second = await openFileNetworkStore(file);
    expect(names((await second.readContext(key)).events)).toEqual(['a']);
    await second.append(key, event('run-1', 'c'));

    const third = await openFileNetworkStore(file);
    expect(names((await third.readContext(key)).events)).toEqual(['a', 'c']);
    expect((await readFile(file, 'utf8')).split('\n')).toHaveLength(3);
  });

  it('a reopened store keeps namespaces apart, also for one contextId', async () => {
    const file = await freshFile();
    const first = await openFileNetworkStore(file);
    const tenant = { namespace: 'principal:a', contextId: 'ctx-1' };
    await first.append(key, event('run-1', 'anonymous-event'));
    await first.append(tenant, event('run-2', 'tenant-event'));

    const second = await openFileNetworkStore(file);
    expect(names((await second.readContext(key)).events)).toEqual(['anonymous-event']);
    expect(names((await second.readContext(tenant)).events)).toEqual(['tenant-event']);
    expect(await second.readRun(tenant, 'run-1')).toEqual([]);
  });

  it('a torn tail is cut by bytes: multi-byte UTF-8 before it and in it stays intact', async () => {
    const file = await freshFile();
    const first = await openFileNetworkStore(file);
    const appended = event('run-1', 'a', { text: 'grüße, 你好 ✓ 🎉' });
    await first.append(key, appended);
    // Torn in the middle of a multi-byte character: `ü` is two bytes, only the first is written.
    const line = Buffer.from(
      JSON.stringify({ namespace: 'anonymous', contextId: 'ctx-1', event: event('run-1', 'b') }),
    );
    const torn = Buffer.concat([line.subarray(0, 30), Buffer.from('ü').subarray(0, 1)]);
    await appendFile(file, torn);

    const second = await openFileNetworkStore(file);
    expect((await second.readContext(key)).events).toEqual([appended]);
    await second.append(key, event('run-1', 'c'));

    const third = await openFileNetworkStore(file);
    expect((await third.readContext(key)).events).toEqual([appended, event('run-1', 'c')]);
  });

  it('a line counts once its newline is written: a complete last line without one is torn too', async () => {
    const file = await freshFile();
    const first = await openFileNetworkStore(file);
    await first.append(key, event('run-1', 'a'));
    await appendFile(
      file,
      JSON.stringify({ namespace: 'anonymous', contextId: 'ctx-1', event: event('run-1', 'b') }),
    );

    const second = await openFileNetworkStore(file);
    expect(names((await second.readContext(key)).events)).toEqual(['a']);
  });

  it('a corrupt line before the last one fails the open, naming the line', async () => {
    const file = await freshFile();
    const good = JSON.stringify({
      namespace: 'anonymous',
      contextId: 'ctx-1',
      event: event('run-1', 'a'),
    });
    await writeFile(file, `${good}\n{"namespace": "anonymous"}\n${good}\n`);
    await expect(openFileNetworkStore(file)).rejects.toThrow(
      `${file}:2: not an event line of a file store`,
    );

    for (const corrupt of [
      'not json',
      'null',
      '{"namespace":"a","contextId":"b","event":{"name":"e"}}',
    ]) {
      await writeFile(file, `${good}\n${corrupt}\n${good}\n`);
      await expect(openFileNetworkStore(file)).rejects.toThrow(`${file}:2: not an event line`);
    }
  });

  it('a file it cannot read fails the open', async () => {
    const file = await freshFile();
    await mkdir(file); // a directory where the file should be
    await expect(openFileNetworkStore(file)).rejects.toThrow(/EISDIR/);
  });

  it('skips blank lines; a missing file is an empty history', async () => {
    const file = await freshFile();
    expect(await (await openFileNetworkStore(file)).readContext(key)).toEqual({ events: [] });

    const good = JSON.stringify({
      namespace: 'anonymous',
      contextId: 'ctx-1',
      event: event('run-1', 'a'),
    });
    await writeFile(file, `\n${good}\n\n`);
    expect(names((await (await openFileNetworkStore(file)).readContext(key)).events)).toEqual([
      'a',
    ]);
  });

  it('after a failed append it refuses appends (the file may end torn) until it is reopened', async () => {
    const file = await freshFile();
    const store = await openFileNetworkStore(file);
    await store.append(key, event('run-1', 'a'));

    // The session directory is gone: the append cannot be written.
    await rm(join(file, '..'), { recursive: true });
    await expect(store.append(key, event('run-1', 'b'))).rejects.toThrow(/ENOENT/);
    // Back again, but this instance no longer knows what the file ends with.
    await mkdir(join(file, '..'));
    await expect(store.append(key, event('run-1', 'c'))).rejects.toThrow(
      'reopen the store to continue',
    );
    // Reads go on from what was appended.
    expect(names((await store.readContext(key)).events)).toEqual(['a']);
  });
});
