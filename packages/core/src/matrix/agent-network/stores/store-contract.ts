import type {
  AgentNetworkStore,
  AgentNetworkStoreKey,
  StoredEvent,
} from './agent-network-store.js';

/**
 * The test functions `runStoreContract` registers its cases with. Vitest's and Jest's `describe`,
 * `it` and `expect` fit as they are; only `toEqual` is used.
 */
export type StoreContractTestApi = {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
  readonly expect: (actual: unknown) => { toEqual(expected: unknown): void };
};

/** Creates the store under test; called once per case. */
export type CreateStore = () => AgentNetworkStore | Promise<AgentNetworkStore>;

let uniqueCounter = 0;
const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(uniqueCounter++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

/** A fresh key per case, so a store shared between cases (e.g. one database) still passes. */
const freshKey = (namespace = unique('principal:tenant')): AgentNetworkStoreKey => ({
  namespace,
  contextId: unique('ctx'),
});

const makeEvent = (
  key: AgentNetworkStoreKey,
  runId: string,
  name: string,
  payload: unknown = { name },
): StoredEvent => ({
  name,
  meta: {
    runId,
    contextId: key.contextId,
    eventId: unique('evt'),
    ts: 1_700_000_000_000,
    depth: 0,
  },
  payload,
});

const appendAll = async (
  store: AgentNetworkStore,
  key: AgentNetworkStoreKey,
  events: readonly StoredEvent[],
): Promise<void> => {
  for (const event of events) await store.append(key, event);
};

const names = (events: readonly StoredEvent[]): string[] => events.map((event) => event.name);

/**
 * Registers the `AgentNetworkStore` contract as test cases, for checking a store adapter with the
 * test runner of your choice:
 *
 * ```ts
 * import { describe, expect, it } from 'vitest';
 * import { runStoreContract } from '@m4trix/core/testing';
 *
 * runStoreContract({ describe, it, expect }, () => createRedisNetworkStore(redis));
 * ```
 *
 * Every case uses its own namespaces and context ids, so the store may be shared between cases.
 * The `deleteContext` cases pass trivially for stores that do not implement it.
 */
export function runStoreContract(test: StoreContractTestApi, createStore: CreateStore): void {
  const { describe, it, expect } = test;

  describe('AgentNetworkStore contract', () => {
    describe('append and read', () => {
      it('reads back appended events unchanged', async () => {
        const store = await createStore();
        const key = freshKey();
        const event = makeEvent(key, 'run-1', 'message', {
          text: 'hi',
          nested: { list: [1, 2, 3], flag: true, none: null },
        });
        await store.append(key, event);

        expect(await store.readRun(key, 'run-1')).toEqual([event]);
        expect((await store.readContext(key)).events).toEqual([event]);
      });

      it('keeps the channels an event was published to', async () => {
        const store = await createStore();
        const key = freshKey();
        const event: StoredEvent = {
          ...makeEvent(key, 'run-1', 'message'),
          channels: ['client', 'side'],
        };
        await store.append(key, event);

        const [read] = await store.readRun(key, 'run-1');
        expect(read?.channels).toEqual(['client', 'side']);
      });

      it('readRun returns the events of the run in append order', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [
          makeEvent(key, 'run-1', 'a'),
          makeEvent(key, 'run-1', 'b'),
          makeEvent(key, 'run-1', 'c'),
        ]);

        expect(names(await store.readRun(key, 'run-1'))).toEqual(['a', 'b', 'c']);
      });

      it('readRun leaves out the other runs of the context', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [
          makeEvent(key, 'run-1', 'a'),
          makeEvent(key, 'run-2', 'b'),
          makeEvent(key, 'run-1', 'c'),
          makeEvent(key, 'run-2', 'd'),
        ]);

        expect(names(await store.readRun(key, 'run-1'))).toEqual(['a', 'c']);
        expect(names(await store.readRun(key, 'run-2'))).toEqual(['b', 'd']);
        expect(await store.readRun(key, 'run-3')).toEqual([]);
      });

      it('readContext returns every run of the context in append order', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [
          makeEvent(key, 'run-1', 'a'),
          makeEvent(key, 'run-2', 'b'),
          makeEvent(key, 'run-1', 'c'),
        ]);

        const page = await store.readContext(key);
        expect(names(page.events)).toEqual(['a', 'b', 'c']);
        expect(page.cursor).toEqual(undefined);
      });

      it('reads of an unknown context are empty', async () => {
        const store = await createStore();
        const key = freshKey();

        expect(await store.readRun(key, 'run-1')).toEqual([]);
        const page = await store.readContext(key, { limit: 10 });
        expect(page.events).toEqual([]);
        expect(page.cursor).toEqual(undefined);
      });

      it('returns snapshots: changing a returned array does not change the store', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);

        const run = (await store.readRun(key, 'run-1')) as StoredEvent[];
        const page = (await store.readContext(key)).events as StoredEvent[];
        try {
          run.length = 0;
          page.length = 0;
        } catch {
          // Frozen arrays are snapshots too.
        }

        expect(names(await store.readRun(key, 'run-1'))).toEqual(['a', 'b']);
        expect(names((await store.readContext(key)).events)).toEqual(['a', 'b']);
      });
    });

    describe('paging', () => {
      it('limit returns the newest events, oldest first, with a cursor to older ones', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4', 'e5'].map((name, i) => makeEvent(key, `run-${i % 2}`, name)),
        );

        const page = await store.readContext(key, { limit: 2 });
        expect(names(page.events)).toEqual(['e4', 'e5']);
        expect(typeof page.cursor).toEqual('string');
      });

      it('walks back to the first event with before, then stops handing out a cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4', 'e5'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const first = await store.readContext(key, { limit: 2 });
        const second = await store.readContext(key, { limit: 2, before: first.cursor });
        const third = await store.readContext(key, { limit: 2, before: second.cursor });

        expect(names(first.events)).toEqual(['e4', 'e5']);
        expect(names(second.events)).toEqual(['e2', 'e3']);
        expect(names(third.events)).toEqual(['e1']);
        expect(third.cursor).toEqual(undefined);
      });

      it('a page that ends exactly at the first event has no cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const first = await store.readContext(key, { limit: 2 });
        const second = await store.readContext(key, { limit: 2, before: first.cursor });

        expect(names(second.events)).toEqual(['e1', 'e2']);
        expect(second.cursor).toEqual(undefined);
      });

      it('before without limit returns everything older than the cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const newest = await store.readContext(key, { limit: 1 });
        const rest = await store.readContext(key, { before: newest.cursor });

        expect(names(rest.events)).toEqual(['e1', 'e2', 'e3']);
        expect(rest.cursor).toEqual(undefined);
      });

      it('a limit beyond the context size returns everything without a cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);

        const page = await store.readContext(key, { limit: 50 });
        expect(names(page.events)).toEqual(['a', 'b']);
        expect(page.cursor).toEqual(undefined);
      });

      it('a cursor stays valid while newer events are appended', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const first = await store.readContext(key, { limit: 2 });
        await appendAll(store, key, [makeEvent(key, 'run-2', 'e5'), makeEvent(key, 'run-2', 'e6')]);
        const older = await store.readContext(key, { limit: 2, before: first.cursor });

        expect(names(first.events)).toEqual(['e3', 'e4']);
        expect(names(older.events)).toEqual(['e1', 'e2']);
        expect(names((await store.readContext(key, { limit: 2 })).events)).toEqual(['e5', 'e6']);
      });
    });

    describe('head', () => {
      it('every non-empty page has a head; empty pages have none', async () => {
        const store = await createStore();
        const key = freshKey();
        expect((await store.readContext(key)).head).toEqual(undefined);
        await appendAll(
          store,
          key,
          ['a', 'b', 'c', 'd'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const all = await store.readContext(key);
        const newest = await store.readContext(key, { limit: 2 });
        const older = await store.readContext(key, { limit: 2, before: newest.cursor });
        const filtered = await store.readContext(key, { names: ['b'] });
        const none = await store.readContext(key, { names: ['unknown'] });

        for (const page of [all, newest, older, filtered]) {
          expect(typeof page.head).toEqual('string');
        }
        expect(none.head).toEqual(undefined);
      });
    });

    describe('names', () => {
      it('returns only the events with one of the names, in append order', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [
          makeEvent(key, 'run-1', 'prompt'),
          makeEvent(key, 'run-1', 'chunk'),
          makeEvent(key, 'run-2', 'answer'),
          makeEvent(key, 'run-2', 'prompt'),
          makeEvent(key, 'run-2', 'chunk'),
        ]);

        const page = await store.readContext(key, { names: ['prompt', 'answer'] });
        expect(names(page.events)).toEqual(['prompt', 'answer', 'prompt']);
        expect(page.cursor).toEqual(undefined);
      });

      it('names nothing in the context: an empty page', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);

        const page = await store.readContext(key, { names: ['unknown'], limit: 1 });
        expect(page.events).toEqual([]);
        expect(page.cursor).toEqual(undefined);
        expect(page.head).toEqual(undefined);
      });

      it('limit pages back through the matching events without skipping or repeating', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['x0', 'm1', 'x1', 'm2', 'm3', 'x2', 'x3', 'm4', 'm5', 'x4'].map((name) =>
            makeEvent(key, 'run-1', name),
          ),
        );
        const only = ['m1', 'm2', 'm3', 'm4', 'm5'];

        const first = await store.readContext(key, { names: only, limit: 2 });
        const second = await store.readContext(key, {
          names: only,
          limit: 2,
          before: first.cursor,
        });
        const third = await store.readContext(key, {
          names: only,
          limit: 2,
          before: second.cursor,
        });

        expect(names(first.events)).toEqual(['m4', 'm5']);
        expect(names(second.events)).toEqual(['m2', 'm3']);
        expect(names(third.events)).toEqual(['m1']);
        // Older events remain (x0), but none with one of the names.
        expect(third.cursor).toEqual(undefined);
      });

      it('a filtered page that ends at the oldest match has no cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['x0', 'm1', 'x1', 'm2'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const page = await store.readContext(key, { names: ['m1', 'm2'], limit: 2 });
        expect(names(page.events)).toEqual(['m1', 'm2']);
        expect(page.cursor).toEqual(undefined);
      });

      it('a filtered cursor stays valid while newer events are appended', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['m1', 'x1', 'm2', 'm3'].map((name) => makeEvent(key, 'run-1', name)),
        );
        const only = ['m1', 'm2', 'm3', 'm4'];

        const first = await store.readContext(key, { names: only, limit: 1 });
        await appendAll(store, key, [makeEvent(key, 'run-2', 'x2'), makeEvent(key, 'run-2', 'm4')]);
        const older = await store.readContext(key, { names: only, before: first.cursor });

        expect(names(first.events)).toEqual(['m3']);
        expect(names(older.events)).toEqual(['m1', 'm2']);
      });
    });

    describe('after', () => {
      it('returns the events after the head, oldest first, without a cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);
        const { head } = await store.readContext(key);
        await appendAll(store, key, [
          makeEvent(key, 'run-2', 'c'),
          makeEvent(key, 'run-1', 'd'),
          makeEvent(key, 'run-2', 'e'),
        ]);

        const page = await store.readContext(key, { after: head });
        expect(names(page.events)).toEqual(['c', 'd', 'e']);
        expect(page.cursor).toEqual(undefined);
        expect(page.head).toEqual((await store.readContext(key, { limit: 1 })).head);
        // The cursor belongs to the context's current history.
        expect(page.reset).toEqual(undefined);
      });

      it('after the newest event: an empty page without head or cursor', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);
        const { head } = await store.readContext(key, { limit: 1 });

        const page = await store.readContext(key, { after: head, limit: 5 });
        expect(page.events).toEqual([]);
        expect(page.cursor).toEqual(undefined);
        expect(page.head).toEqual(undefined);
      });

      it('limit returns the oldest events after the cursor; heads chain forward', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((name) => makeEvent(key, 'run-1', name)),
        );
        const start = (await store.readContext(key, { names: ['e1'] })).head;

        const first = await store.readContext(key, { after: start, limit: 2 });
        const second = await store.readContext(key, { after: first.head, limit: 2 });
        const third = await store.readContext(key, { after: second.head, limit: 2 });
        const fourth = await store.readContext(key, { after: third.head, limit: 2 });

        expect(names(first.events)).toEqual(['e2', 'e3']);
        expect(first.cursor).toEqual(undefined);
        expect(names(second.events)).toEqual(['e4', 'e5']);
        expect(names(third.events)).toEqual(['e6']);
        expect(fourth.events).toEqual([]);
      });

      it('the head of an older page reads the events newer than that page', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4', 'e5'].map((name) => makeEvent(key, 'run-1', name)),
        );

        const newest = await store.readContext(key, { limit: 2 });
        const older = await store.readContext(key, { limit: 2, before: newest.cursor });
        const newer = await store.readContext(key, { after: older.head });

        expect(names(older.events)).toEqual(['e2', 'e3']);
        expect(names(newer.events)).toEqual(['e4', 'e5']);
      });

      it('a head stays valid while newer events are appended', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a')]);
        const { head } = await store.readContext(key);

        await appendAll(store, key, [makeEvent(key, 'run-2', 'b')]);
        const once = await store.readContext(key, { after: head });
        await appendAll(store, key, [makeEvent(key, 'run-3', 'c')]);
        const twice = await store.readContext(key, { after: head });

        expect(names(once.events)).toEqual(['b']);
        expect(names(twice.events)).toEqual(['b', 'c']);
      });

      it('rejects after and before together', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['e1', 'e2', 'e3', 'e4'].map((name) => makeEvent(key, 'run-1', name)),
        );
        const page = await store.readContext(key, { limit: 2 });

        // Thrown or rejected: either way the read fails.
        let failure: unknown;
        try {
          await store.readContext(key, { after: page.head, before: page.cursor });
        } catch (error) {
          failure = error;
        }
        expect(failure instanceof Error).toEqual(true);
      });

      it('filtered heads chain forward over events with other names, never skipping or repeating', async () => {
        const store = await createStore();
        const key = freshKey();
        const only = ['prompt', 'answer'];
        const seen: string[] = [];
        let cursor: string | undefined;
        // Read incrementally (as a cache does): keep the last head, read after it.
        const readNew = async (): Promise<void> => {
          const page = await store.readContext(key, { names: only, after: cursor });
          seen.push(...page.events.map((event) => event.meta.eventId as string));
          cursor = page.head ?? cursor;
        };
        const appended: StoredEvent[] = [];
        const append = async (runId: string, name: string): Promise<void> => {
          const event = makeEvent(key, runId, name);
          appended.push(event);
          await store.append(key, event);
        };

        await append('run-1', 'prompt');
        await append('run-1', 'chunk');
        await readNew();
        await append('run-1', 'chunk');
        await readNew();
        await append('run-1', 'answer');
        await append('run-2', 'chunk');
        await readNew();
        await append('run-2', 'prompt');
        await append('run-2', 'chunk');
        await append('run-2', 'answer');
        await readNew();
        await readNew();

        expect(seen).toEqual(
          appended
            .filter((event) => only.includes(event.name))
            .map((event) => event.meta.eventId as string),
        );
      });

      it('names and limit page forward through the matching events', async () => {
        const store = await createStore();
        const key = freshKey();
        await appendAll(
          store,
          key,
          ['m1', 'x1', 'm2', 'x2', 'm3', 'x3'].map((name) => makeEvent(key, 'run-1', name)),
        );
        const only = ['m1', 'm2', 'm3'];
        const start = (await store.readContext(key, { names: ['m1'] })).head;

        const first = await store.readContext(key, { names: only, after: start, limit: 1 });
        const second = await store.readContext(key, { names: only, after: first.head, limit: 1 });
        const third = await store.readContext(key, { names: only, after: second.head, limit: 1 });

        expect(names(first.events)).toEqual(['m2']);
        expect(names(second.events)).toEqual(['m3']);
        expect(third.events).toEqual([]);
      });
    });

    describe('isolation', () => {
      it('the same contextId in two namespaces holds two separate histories', async () => {
        const store = await createStore();
        const contextId = unique('shared-ctx');
        const alice: AgentNetworkStoreKey = { namespace: unique('principal:alice'), contextId };
        const bob: AgentNetworkStoreKey = { namespace: unique('principal:bob'), contextId };
        await store.append(alice, makeEvent(alice, 'run-1', 'from-alice'));
        await store.append(bob, makeEvent(bob, 'run-1', 'from-bob'));

        expect(names(await store.readRun(alice, 'run-1'))).toEqual(['from-alice']);
        expect(names(await store.readRun(bob, 'run-1'))).toEqual(['from-bob']);
        expect(names((await store.readContext(alice)).events)).toEqual(['from-alice']);
        expect(names((await store.readContext(bob)).events)).toEqual(['from-bob']);
      });

      it('namespaces and context ids are not concatenated ambiguously', async () => {
        const store = await createStore();
        const base = unique('principal:a');
        const one: AgentNetworkStoreKey = { namespace: base, contextId: 'b:c' };
        const two: AgentNetworkStoreKey = { namespace: `${base}:b`, contextId: 'c' };
        await store.append(one, makeEvent(one, 'run-1', 'one'));
        await store.append(two, makeEvent(two, 'run-1', 'two'));

        expect(names((await store.readContext(one)).events)).toEqual(['one']);
        expect(names((await store.readContext(two)).events)).toEqual(['two']);
      });

      it('contexts of one namespace are separate', async () => {
        const store = await createStore();
        const namespace = unique('principal:tenant');
        const first = freshKey(namespace);
        const second = freshKey(namespace);
        await store.append(first, makeEvent(first, 'run-1', 'first'));
        await store.append(second, makeEvent(second, 'run-1', 'second'));

        expect(names((await store.readContext(first)).events)).toEqual(['first']);
        expect(names(await store.readRun(second, 'run-1'))).toEqual(['second']);
      });

      it('concurrent appends to different contexts keep each context in order', async () => {
        const store = await createStore();
        const keys = Array.from({ length: 8 }, () => freshKey());
        const perContext = 5;

        // One sequential writer per context, all contexts at once (as concurrent runs do).
        await Promise.all(
          keys.map(async (key) => {
            for (let i = 0; i < perContext; i++) {
              await store.append(key, makeEvent(key, 'run-1', `${key.contextId}#${i}`));
            }
          }),
        );

        for (const key of keys) {
          const expected = Array.from({ length: perContext }, (_, i) => `${key.contextId}#${i}`);
          expect(names(await store.readRun(key, 'run-1'))).toEqual(expected);
          expect(names((await store.readContext(key)).events)).toEqual(expected);
        }
      });
    });

    describe('readLatest', () => {
      it('returns the newest event with one of the names and a cursor to read after it', async () => {
        const store = await createStore();
        if (!store.readLatest) return;
        const key = freshKey();
        await appendAll(store, key, [
          makeEvent(key, 'run-1', 'checkpoint', { n: 1 }),
          makeEvent(key, 'run-1', 'a'),
          makeEvent(key, 'run-2', 'reset', { n: 2 }),
          makeEvent(key, 'run-2', 'b'),
          makeEvent(key, 'run-2', 'checkpoint', { n: 3 }),
          makeEvent(key, 'run-3', 'c'),
          makeEvent(key, 'run-3', 'reset', { n: 4 }),
          makeEvent(key, 'run-3', 'd'),
        ]);

        const latest = await store.readLatest(key, ['checkpoint']);
        const either = await store.readLatest(key, ['checkpoint', 'reset']);

        expect(latest?.event.payload).toEqual({ n: 3 });
        expect(names((await store.readContext(key, { after: latest?.cursor })).events)).toEqual([
          'c',
          'reset',
          'd',
        ]);
        expect(either?.event.payload).toEqual({ n: 4 });
        expect(
          names((await store.readContext(key, { names: ['d'], after: either?.cursor })).events),
        ).toEqual(['d']);
        const page = await store.readContext(key, { names: ['checkpoint'], limit: 1 });
        expect(page.events).toEqual([latest?.event]);
      });

      it('its cursor stays valid while newer events are appended', async () => {
        const store = await createStore();
        if (!store.readLatest) return;
        const key = freshKey();
        await appendAll(store, key, [
          makeEvent(key, 'run-1', 'checkpoint'),
          makeEvent(key, 'run-1', 'a'),
        ]);
        const latest = await store.readLatest(key, ['checkpoint']);

        await appendAll(store, key, [makeEvent(key, 'run-2', 'b')]);

        expect(names((await store.readContext(key, { after: latest?.cursor })).events)).toEqual([
          'a',
          'b',
        ]);
      });

      it('sees only the events of its own namespace and context', async () => {
        const store = await createStore();
        if (!store.readLatest) return;
        const contextId = unique('shared-ctx');
        const alice: AgentNetworkStoreKey = { namespace: unique('principal:alice'), contextId };
        const bob: AgentNetworkStoreKey = { namespace: unique('principal:bob'), contextId };
        const other = freshKey(alice.namespace);
        await store.append(alice, makeEvent(alice, 'run-1', 'checkpoint', { who: 'alice' }));
        await store.append(bob, makeEvent(bob, 'run-1', 'checkpoint', { who: 'bob' }));
        await store.append(other, makeEvent(other, 'run-1', 'checkpoint', { who: 'other' }));

        expect((await store.readLatest(alice, ['checkpoint']))?.event.payload).toEqual({
          who: 'alice',
        });
        expect((await store.readLatest(bob, ['checkpoint']))?.event.payload).toEqual({
          who: 'bob',
        });
      });

      it('is undefined without a matching event', async () => {
        const store = await createStore();
        if (!store.readLatest) return;
        const key = freshKey();

        expect(await store.readLatest(key, ['checkpoint'])).toEqual(undefined);
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a')]);
        expect(await store.readLatest(key, ['checkpoint'])).toEqual(undefined);
      });
    });

    describe('deleteContext', () => {
      it('removes the context in its namespace only', async () => {
        const store = await createStore();
        if (!store.deleteContext) return;
        const contextId = unique('shared-ctx');
        const alice: AgentNetworkStoreKey = { namespace: unique('principal:alice'), contextId };
        const bob: AgentNetworkStoreKey = { namespace: unique('principal:bob'), contextId };
        const other = freshKey(alice.namespace);
        await store.append(alice, makeEvent(alice, 'run-1', 'alice'));
        await store.append(bob, makeEvent(bob, 'run-1', 'bob'));
        await store.append(other, makeEvent(other, 'run-1', 'other'));

        await store.deleteContext(alice);

        expect(await store.readRun(alice, 'run-1')).toEqual([]);
        expect((await store.readContext(alice)).events).toEqual([]);
        expect(names((await store.readContext(bob)).events)).toEqual(['bob']);
        expect(names((await store.readContext(other)).events)).toEqual(['other']);
      });

      it('a deleted context starts a fresh history on the next append', async () => {
        const store = await createStore();
        if (!store.deleteContext) return;
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'old')]);

        await store.deleteContext(key);
        await store.append(key, makeEvent(key, 'run-2', 'new'));

        expect(names((await store.readContext(key)).events)).toEqual(['new']);
        expect(await store.readRun(key, 'run-1')).toEqual([]);
      });

      it('deleting an unknown context succeeds', async () => {
        const store = await createStore();
        if (!store.deleteContext) return;
        const key = freshKey();

        await store.deleteContext(key);

        expect((await store.readContext(key)).events).toEqual([]);
      });
    });

    // A reader that keeps state derived from earlier pages (e.g. a fold cache) must learn that a
    // cursor no longer belongs to the context's history; otherwise it would add the new history's
    // events onto state derived from the deleted one.
    describe('stale cursors', () => {
      it('after a cursor of a deleted context: a reset page with the new history from its start', async () => {
        const store = await createStore();
        if (!store.deleteContext) return;
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);
        const { head } = await store.readContext(key);

        await store.deleteContext(key);
        await appendAll(store, key, [
          makeEvent(key, 'run-2', 'c'),
          makeEvent(key, 'run-2', 'a'),
          makeEvent(key, 'run-2', 'd'),
        ]);

        const page = await store.readContext(key, { after: head });
        expect(page.reset).toEqual(true);
        expect(names(page.events)).toEqual(['c', 'a', 'd']);
        expect(page.head).toEqual((await store.readContext(key, { limit: 1 })).head);
        // Filtered and limited reads start over the same way.
        const filtered = await store.readContext(key, { after: head, names: ['a', 'd'], limit: 1 });
        expect(filtered.reset).toEqual(true);
        expect(names(filtered.events)).toEqual(['a']);
        // Its own heads are current: reading on from them is not a reset.
        const next = await store.readContext(key, { after: page.head });
        expect(next).toEqual({ events: [] });
      });

      it('a readLatest cursor of a deleted context is stale too', async () => {
        const store = await createStore();
        if (!store.deleteContext || !store.readLatest) return;
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a'), makeEvent(key, 'run-1', 'b')]);
        const latest = await store.readLatest(key, ['a']);

        await store.deleteContext(key);
        await appendAll(store, key, [makeEvent(key, 'run-2', 'c')]);

        const page = await store.readContext(key, { after: latest?.cursor });
        expect(page.reset).toEqual(true);
        expect(names(page.events)).toEqual(['c']);
      });

      it('after a cursor of a deleted context that has no events again: an empty reset page', async () => {
        const store = await createStore();
        if (!store.deleteContext) return;
        const key = freshKey();
        await appendAll(store, key, [makeEvent(key, 'run-1', 'a')]);
        const { head } = await store.readContext(key);

        await store.deleteContext(key);

        expect(await store.readContext(key, { after: head })).toEqual({
          events: [],
          reset: true,
        });
      });
    });
  });
}
