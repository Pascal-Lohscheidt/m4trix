import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentNetworkStore,
  AgentNetworkStoreKey,
  EventPage,
  ReadContextOptions,
  StoredEvent,
} from './agent-network-store.js';
import {
  createInMemoryNetworkStore,
  DEFAULT_IN_MEMORY_STORE_MAX_CONTEXTS,
  DEFAULT_IN_MEMORY_STORE_TTL,
} from './inmemory-network-store.js';
import { runStoreContract, type StoreContractTestApi } from './store-contract.js';

describe('createInMemoryNetworkStore', () => {
  runStoreContract({ describe, it, expect }, () => createInMemoryNetworkStore());

  describe('with only the required methods', () => {
    // The contract skips the optional methods' cases for stores that leave them out.
    runStoreContract({ describe, it, expect }, () => {
      const {
        readLatest: _readLatest,
        deleteContext: _deleteContext,
        ...required
      } = createInMemoryNetworkStore();
      return required;
    });
  });

  /** A clock the test moves by hand. */
  const manualClock = (start = 1_000_000) => {
    let now = start;
    return {
      clock: { unsafeCurrentTimeMillis: () => now },
      advance: (millis: number) => {
        now += millis;
      },
    };
  };

  const key = (contextId: string, namespace = 'anonymous'): AgentNetworkStoreKey => ({
    namespace,
    contextId,
  });

  const event = (contextId: string, name: string, runId = 'run-1'): StoredEvent => ({
    name,
    meta: { runId, contextId },
    payload: {},
  });

  const contextNames = async (store: AgentNetworkStore, contextId: string): Promise<string[]> =>
    (await store.readContext(key(contextId))).events.map((e) => e.name);

  const MINUTE = 60_000;

  describe('ttl', () => {
    it('drops a context ttl after its last event', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: '10 minutes', clock });
      await store.append(key('ctx'), event('ctx', 'a'));

      advance(10 * MINUTE - 1);
      expect(await contextNames(store, 'ctx')).toEqual(['a']);

      advance(1);
      expect(await contextNames(store, 'ctx')).toEqual([]);
      expect(await store.readRun(key('ctx'), 'run-1')).toEqual([]);
    });

    it('every event restarts the ttl; reads do not', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: '10 minutes', clock });
      await store.append(key('ctx'), event('ctx', 'a'));
      advance(8 * MINUTE);
      await store.append(key('ctx'), event('ctx', 'b'));

      advance(8 * MINUTE);
      expect(await contextNames(store, 'ctx')).toEqual(['a', 'b']);

      advance(2 * MINUTE);
      expect(await contextNames(store, 'ctx')).toEqual([]);
    });

    it('an expired context starts over on its next event', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: '1 minute', clock });
      await store.append(key('ctx'), event('ctx', 'old'));
      advance(MINUTE);

      await store.append(key('ctx'), event('ctx', 'new'));

      expect(await contextNames(store, 'ctx')).toEqual(['new']);
    });

    it('defaults to 30 minutes', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ clock });
      await store.append(key('ctx'), event('ctx', 'a'));

      advance(30 * MINUTE - 1);
      expect(await contextNames(store, 'ctx')).toEqual(['a']);
      advance(1);
      expect(await contextNames(store, 'ctx')).toEqual([]);
      expect(DEFAULT_IN_MEMORY_STORE_TTL).toBe('30 minutes');
    });

    it('Infinity keeps contexts until they are evicted', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: Number.POSITIVE_INFINITY, clock });
      await store.append(key('ctx'), event('ctx', 'a'));

      advance(365 * 24 * 60 * MINUTE);

      expect(await contextNames(store, 'ctx')).toEqual(['a']);
    });
  });

  describe('maxContexts', () => {
    it('evicts the least recently used context once a new one goes over the cap', async () => {
      const store = createInMemoryNetworkStore({ maxContexts: 2 });
      await store.append(key('a'), event('a', 'a1'));
      await store.append(key('b'), event('b', 'b1'));
      // Reading `a` makes `b` the least recently used.
      await store.readContext(key('a'));

      await store.append(key('c'), event('c', 'c1'));

      expect(await contextNames(store, 'a')).toEqual(['a1']);
      expect(await contextNames(store, 'b')).toEqual([]);
      expect(await contextNames(store, 'c')).toEqual(['c1']);
    });

    it('counts the same contextId in two namespaces as two contexts', async () => {
      const store = createInMemoryNetworkStore({ maxContexts: 1 });
      await store.append(key('ctx', 'principal:alice'), event('ctx', 'alice'));
      await store.append(key('ctx', 'principal:bob'), event('ctx', 'bob'));

      expect((await store.readContext(key('ctx', 'principal:alice'))).events).toEqual([]);
      expect(
        (await store.readContext(key('ctx', 'principal:bob'))).events.map((e) => e.name),
      ).toEqual(['bob']);
    });

    it('expired contexts make room before live ones are evicted', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: '10 minutes', maxContexts: 2, clock });
      await store.append(key('old'), event('old', 'o1'));
      advance(5 * MINUTE);
      await store.append(key('live'), event('live', 'l1'));
      // `old` is now the most recently used, but its last event is the oldest.
      await store.readContext(key('old'));
      advance(5 * MINUTE);

      await store.append(key('new'), event('new', 'n1'));

      expect(await contextNames(store, 'live')).toEqual(['l1']);
      expect(await contextNames(store, 'new')).toEqual(['n1']);
      expect(await contextNames(store, 'old')).toEqual([]);
    });

    it('defaults to 1000 contexts', async () => {
      const store = createInMemoryNetworkStore();
      for (let i = 0; i <= 1000; i++) await store.append(key(`ctx-${i}`), event(`ctx-${i}`, 'e'));

      expect(await contextNames(store, 'ctx-0')).toEqual([]);
      expect(await contextNames(store, 'ctx-1')).toEqual(['e']);
      expect(await contextNames(store, 'ctx-1000')).toEqual(['e']);
      expect(DEFAULT_IN_MEMORY_STORE_MAX_CONTEXTS).toBe(1000);
    });
  });

  describe('readLatest', () => {
    it('is implemented, so the contract checks it', async () => {
      const store = createInMemoryNetworkStore();
      await store.append(key('ctx'), event('ctx', 'checkpoint'));

      expect(typeof store.readLatest).toBe('function');
      expect((await store.readLatest?.(key('ctx'), ['checkpoint']))?.event.name).toBe('checkpoint');
    });

    it('is undefined for an expired context', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: '1 minute', clock });
      await store.append(key('ctx'), event('ctx', 'checkpoint'));
      advance(MINUTE);

      expect(await store.readLatest?.(key('ctx'), ['checkpoint'])).toBeUndefined();
    });
  });

  describe('cursors', () => {
    it('rejects a cursor it did not hand out', async () => {
      const store = createInMemoryNetworkStore();
      await store.append(key('ctx'), event('ctx', 'a'));

      await expect(store.readContext(key('ctx'), { before: 'nonsense' })).rejects.toThrow(
        /invalid cursor/,
      );
      await expect(store.readContext(key('ctx'), { after: '1:x' })).rejects.toThrow(
        /invalid cursor/,
      );
    });

    it('after a cursor of a deleted context, the new history is read from its start', async () => {
      const store = createInMemoryNetworkStore();
      await store.append(key('ctx'), event('ctx', 'old'));
      const { head, cursor } = await store.readContext(key('ctx'));
      await store.deleteContext?.(key('ctx'));
      await store.append(key('ctx'), event('ctx', 'new-1', 'run-2'));
      await store.append(key('ctx'), event('ctx', 'new-2', 'run-2'));
      const newest = await store.readContext(key('ctx'), { limit: 1 });

      // Every event of the new history was appended after the old one; the page says the cursor
      // was stale, so state derived from the old history is not carried over.
      const page = await store.readContext(key('ctx'), { after: head });
      expect(page.events.map((e) => e.name)).toEqual(['new-1', 'new-2']);
      expect(page.reset).toBe(true);
      expect(cursor).toBeUndefined();
      // Nothing of the new history is older than a page of the deleted one.
      expect(await store.readContext(key('ctx'), { before: head })).toEqual({ events: [] });
      expect(newest.head).not.toEqual(head);
    });

    it('a cursor of an expired context is stale, with or without a new history', async () => {
      const { clock, advance } = manualClock();
      const store = createInMemoryNetworkStore({ ttl: '10 minutes', clock });
      await store.append(key('ctx'), event('ctx', 'old'));
      const { head } = await store.readContext(key('ctx'));

      advance(10 * MINUTE);
      expect(await store.readContext(key('ctx'), { after: head })).toEqual({
        events: [],
        reset: true,
      });

      await store.append(key('ctx'), event('ctx', 'new', 'run-2'));
      const page = await store.readContext(key('ctx'), { after: head });
      expect(page.events.map((e) => e.name)).toEqual(['new']);
      expect(page.reset).toBe(true);
    });

    it('a cursor of an evicted context is stale', async () => {
      const store = createInMemoryNetworkStore({ maxContexts: 1 });
      await store.append(key('a'), event('a', 'old'));
      const { head } = await store.readContext(key('a'));

      await store.append(key('b'), event('b', 'other'));
      expect(await store.readContext(key('a'), { after: head })).toEqual({
        events: [],
        reset: true,
      });
    });

    it('a cursor of another context is stale', async () => {
      const store = createInMemoryNetworkStore();
      await store.append(key('a'), event('a', 'a-1'));
      await store.append(key('b'), event('b', 'b-1'));
      const { head } = await store.readContext(key('a'));

      const page = await store.readContext(key('b'), { after: head });
      expect(page.events.map((e) => e.name)).toEqual(['b-1']);
      expect(page.reset).toBe(true);
    });
  });

  describe('options', () => {
    it.each([0, -1, 1.5, Number.NaN])('rejects maxContexts %s', (maxContexts) => {
      expect(() => createInMemoryNetworkStore({ maxContexts })).toThrow(/maxContexts/);
    });

    it.each([0, -5, 'nonsense'])('rejects ttl %s', (ttl) => {
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
        createInMemoryNetworkStore({ ttl: ttl as any }),
      ).toThrow(/ttl/);
    });
  });

  describe('types', () => {
    it('implements the async store interface', () => {
      const store = createInMemoryNetworkStore();
      expectTypeOf(store).toEqualTypeOf<AgentNetworkStore>();
      expectTypeOf(store.append).parameters.toEqualTypeOf<[AgentNetworkStoreKey, StoredEvent]>();
      expectTypeOf(store.append).returns.toEqualTypeOf<Promise<void>>();
      expectTypeOf(store.readRun).parameters.toEqualTypeOf<[AgentNetworkStoreKey, string]>();
      expectTypeOf(store.readRun).returns.toEqualTypeOf<Promise<readonly StoredEvent[]>>();
      expectTypeOf(store.readContext).parameters.toEqualTypeOf<
        [AgentNetworkStoreKey, (ReadContextOptions | undefined)?]
      >();
      expectTypeOf(store.readContext).returns.toEqualTypeOf<Promise<EventPage>>();
      expectTypeOf<AgentNetworkStore['deleteContext']>().toEqualTypeOf<
        ((key: AgentNetworkStoreKey) => Promise<void>) | undefined
      >();
      expectTypeOf<AgentNetworkStoreKey>().toEqualTypeOf<{
        readonly namespace: string;
        readonly contextId: string;
      }>();
      expectTypeOf<EventPage>().toEqualTypeOf<{
        readonly events: readonly StoredEvent[];
        readonly cursor?: string;
        readonly head?: string;
        readonly reset?: true;
      }>();
      expectTypeOf<ReadContextOptions>().toEqualTypeOf<{
        readonly limit?: number;
        readonly before?: string;
        readonly after?: string;
        readonly names?: readonly string[];
      }>();
      expectTypeOf<AgentNetworkStore['readLatest']>().toEqualTypeOf<
        | ((
            key: AgentNetworkStoreKey,
            names: readonly string[],
          ) => Promise<{ readonly event: StoredEvent; readonly cursor: string } | undefined>)
        | undefined
      >();
    });

    it('runStoreContract takes injected test functions and a store factory', () => {
      expectTypeOf(runStoreContract).parameters.toEqualTypeOf<
        [StoreContractTestApi, () => AgentNetworkStore | Promise<AgentNetworkStore>]
      >();
      expectTypeOf(runStoreContract).returns.toEqualTypeOf<void>();
      // Vitest's own functions fit the injected API as they are.
      expectTypeOf({ describe, it, expect }).toMatchTypeOf<StoreContractTestApi>();
    });
  });
});
