// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredEvent } from '@m4trix/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openSession } from './session.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'm4trix-code-session-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const event = (contextId: string, name: string): StoredEvent => ({
  name,
  meta: { runId: 'run-1', contextId, eventId: name, ts: 1, depth: 0 },
  payload: {},
  channels: [],
});

describe('session', () => {
  test('a new session creates its directory, a context id and an empty history', async () => {
    const dir = join(root, 'nested', 'session');
    const session = await openSession(dir);

    expect(session.resumed).toBe(false);
    expect(session.contextId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'))).toEqual({
      contextId: session.contextId,
    });
    expect(session.store.file).toBe(join(dir, 'events.jsonl'));
    const key = { namespace: 'anonymous', contextId: session.contextId };
    expect(await session.store.readContext(key)).toEqual({ events: [] });
  });

  test('reopening it resumes the same context with its history, as a new process does', async () => {
    const first = await openSession(root);
    const key = { namespace: 'anonymous', contextId: first.contextId };
    await first.store.append(key, event(first.contextId, 'user-prompt'));

    const second = await openSession(root);
    expect(second.resumed).toBe(true);
    expect(second.contextId).toBe(first.contextId);
    expect((await second.store.readContext(key)).events).toEqual([
      event(first.contextId, 'user-prompt'),
    ]);
  });

  test('newContext() starts a fresh context in the same store, also for the next process', async () => {
    const session = await openSession(root);
    const old = session.contextId;
    await session.store.append(
      { namespace: 'anonymous', contextId: old },
      event(old, 'user-prompt'),
    );

    const fresh = await session.newContext();
    expect(fresh).not.toBe(old);
    expect(session.contextId).toBe(fresh);

    const next = await openSession(root);
    expect(next.contextId).toBe(fresh);
    // The earlier conversation is still in the store, under its own context id.
    const page = await next.store.readContext({ namespace: 'anonymous', contextId: old });
    expect(page.events).toHaveLength(1);
  });

  test('a session.json that is not a session fails the open with a clear error', async () => {
    for (const content of ['{', '{"contextId": ""}', '[]']) {
      await writeFile(join(root, 'session.json'), content);
      await expect(openSession(root)).rejects.toThrow(
        `${join(root, 'session.json')} is not an m4trix-code session`,
      );
    }
  });

  test('a session.json it cannot read fails the open', async () => {
    await mkdir(join(root, 'session.json'));
    await expect(openSession(root)).rejects.toThrow(/EISDIR/);
  });
});
