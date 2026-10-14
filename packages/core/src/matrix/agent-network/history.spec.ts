import { describe, expect, expectTypeOf, it } from 'vitest';
import { createEventHistory, type EventHistory, emptyEventHistory } from './history.js';
import type {
  AgentNetworkStore,
  AgentNetworkStoreKey,
  EventPage,
  ReadContextOptions,
  StoredEvent,
} from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

const scope = { runId: 'run-1', contextId: 'ctx', principalId: 'alice' };
const aliceKey: AgentNetworkStoreKey = { namespace: 'principal:alice', contextId: 'ctx' };

const event = (name: string, payload: unknown = {}, runId = 'run-1'): StoredEvent => ({
  name,
  meta: { runId, contextId: 'ctx', principalId: 'alice' },
  payload,
});

const names = (events: readonly StoredEvent[]): string[] => events.map((e) => e.name);

/** An in-memory store whose calls are recorded; `readLatest` left out with `withoutReadLatest`. */
async function recordingStore(
  events: readonly StoredEvent[],
  { withoutReadLatest = false } = {},
): Promise<{ store: AgentNetworkStore; calls: string[] }> {
  const inner = createInMemoryNetworkStore();
  for (const e of events) await inner.append(aliceKey, e);
  const calls: string[] = [];
  const store: AgentNetworkStore = {
    append: (key, e) => inner.append(key, e),
    readRun: (key, runId) => inner.readRun(key, runId),
    readContext: (key, options) => {
      calls.push(`readContext ${JSON.stringify(options)}`);
      return inner.readContext(key, options);
    },
    ...(!withoutReadLatest && {
      readLatest: (key: AgentNetworkStoreKey, eventNames: readonly string[]) => {
        calls.push(`readLatest ${JSON.stringify(eventNames)}`);
        return inner.readLatest?.(key, eventNames) ?? Promise.resolve(undefined);
      },
    }),
  };
  return { store, calls };
}

/** The error a call rejects with; fails the test when it resolves. */
const rejectionOf = async (call: () => Promise<unknown>): Promise<Error> => {
  const result = await call().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  return result as Error;
};

const invalidReads: Array<[string, unknown, RegExp]> = [
  ['names that is not an array', { names: 'prompt' }, /names must be an array of event names/],
  ['names with a non-string', { names: ['prompt', 1] }, /names must be an array of event names/],
  ['a before that is not a string', { before: 2 }, /before must be a cursor string/],
  ['an after that is not a string', { after: 3 }, /after must be a cursor string/],
  ['after and before together', { after: '0:1', before: '0:2' }, /after or before, not both/],
];

describe('createEventHistory', () => {
  describe('context', () => {
    it('passes names, after and limit through to the store', async () => {
      const { store } = await recordingStore([
        event('prompt'),
        event('chunk'),
        event('answer'),
        event('prompt', {}, 'run-2'),
        event('chunk', {}, 'run-2'),
        event('answer', {}, 'run-2'),
      ]);
      const history = createEventHistory(store, scope);

      const first = await history.context({ names: ['prompt', 'answer'], limit: 1 });
      const older = await history.context({
        names: ['prompt', 'answer'],
        before: first.cursor,
      });
      const prompts = await history.context({ names: ['prompt'] });
      const newer = await history.context({ names: ['answer'], after: prompts.head });

      expect(names(first.events)).toEqual(['answer']);
      expect(names(older.events)).toEqual(['prompt', 'answer', 'prompt']);
      expect(names(newer.events)).toEqual(['answer']);
      expect(typeof first.head).toBe('string');
    });

    it('reads incrementally: the head of one read is the after of the next', async () => {
      const { store } = await recordingStore([event('prompt'), event('chunk')]);
      const history = createEventHistory(store, scope);

      const first = await history.context({ names: ['prompt', 'answer'] });
      await store.append(aliceKey, event('chunk'));
      await store.append(aliceKey, event('answer'));
      const second = await history.context({ names: ['prompt', 'answer'], after: first.head });
      const third = await history.context({ names: ['prompt', 'answer'], after: second.head });

      expect(names(first.events)).toEqual(['prompt']);
      expect(names(second.events)).toEqual(['answer']);
      expect(third).toEqual({ events: [] });
    });

    it('an empty names list matches nothing, without reading the store', async () => {
      const { store, calls } = await recordingStore([event('prompt')]);

      const page = await createEventHistory(store, scope).context({ names: [], limit: 5 });

      expect(page).toEqual({ events: [] });
      expect(calls).toEqual([]);
    });

    it.each(invalidReads)('rejects %s without reading the store', async (_, options, message) => {
      const { store, calls } = await recordingStore([event('prompt')]);
      const history = createEventHistory(store, scope);

      const error = await rejectionOf(() => history.context(options as ReadContextOptions));

      expect(error.message).toMatch(/^history\.context: /);
      expect(error.message).toMatch(message);
      expect(calls).toEqual([]);
    });
  });

  describe('latest', () => {
    it("uses the store's readLatest when it has one", async () => {
      const { store, calls } = await recordingStore([
        event('checkpoint', { n: 1 }),
        event('prompt'),
        event('checkpoint', { n: 2 }),
        event('answer'),
      ]);
      const history = createEventHistory(store, scope);

      const latest = await history.latest(['checkpoint']);

      expect(latest?.event.payload).toEqual({ n: 2 });
      expect(calls).toEqual(['readLatest ["checkpoint"]']);
      expect(names((await history.context({ after: latest?.cursor })).events)).toEqual(['answer']);
    });

    it('falls back to the newest match of readContext without readLatest', async () => {
      const { store, calls } = await recordingStore(
        [
          event('checkpoint', { n: 1 }),
          event('prompt'),
          event('reset', { n: 2 }),
          event('answer'),
          event('checkpoint', { n: 3 }),
          event('chunk'),
        ],
        { withoutReadLatest: true },
      );
      const history = createEventHistory(store, scope);

      const latest = await history.latest(['checkpoint', 'reset']);
      await store.append(aliceKey, event('prompt', {}, 'run-2'));
      const after = await history.context({ after: latest?.cursor });

      expect(latest?.event.payload).toEqual({ n: 3 });
      expect(calls[0]).toEqual('readContext {"names":["checkpoint","reset"],"limit":1}');
      expect(names(after.events)).toEqual(['chunk', 'prompt']);
    });

    it('is undefined without a matching event, with and without readLatest', async () => {
      for (const withoutReadLatest of [false, true]) {
        const { store } = await recordingStore([event('prompt')], { withoutReadLatest });
        const history = createEventHistory(store, scope);

        expect(await history.latest(['checkpoint'])).toBeUndefined();
      }
    });

    it("reads only the scope's namespace", async () => {
      for (const withoutReadLatest of [false, true]) {
        const { store } = await recordingStore([event('checkpoint')], { withoutReadLatest });
        const asBob = createEventHistory(store, { ...scope, principalId: 'bob' });
        const anonymous = createEventHistory(store, { runId: 'run-1', contextId: 'ctx' });

        expect(await asBob.latest(['checkpoint'])).toBeUndefined();
        expect(await anonymous.latest(['checkpoint'])).toBeUndefined();
      }
    });

    it('fails when the fallback page has no head (the store breaks the contract)', async () => {
      const store: AgentNetworkStore = {
        append: async () => {},
        readRun: async () => [],
        readContext: async () => ({ events: [event('checkpoint')] }),
      };

      const error = await rejectionOf(() =>
        createEventHistory(store, scope).latest(['checkpoint']),
      );

      expect(error.message).toMatch(/history\.latest: .*head/);
    });

    it('an empty names list is undefined, without reading the store', async () => {
      const { store, calls } = await recordingStore([event('checkpoint')]);

      expect(await createEventHistory(store, scope).latest([])).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it.each([
      ['names that is not an array', 'checkpoint'],
      ['names with a non-string', ['checkpoint', null]],
    ])('rejects %s', async (_, invalid) => {
      const { store, calls } = await recordingStore([event('checkpoint')]);

      const error = await rejectionOf(() =>
        createEventHistory(store, scope).latest(invalid as readonly string[]),
      );

      expect(error.message).toMatch(/^history\.latest: names must be an array of event names/);
      expect(calls).toEqual([]);
    });
  });

  it('types', () => {
    expectTypeOf<EventHistory['context']>().toEqualTypeOf<
      (options?: ReadContextOptions) => Promise<EventPage>
    >();
    expectTypeOf<EventHistory['latest']>().toEqualTypeOf<
      (
        names: readonly string[],
      ) => Promise<{ readonly event: StoredEvent; readonly cursor: string } | undefined>
    >();
  });
});

describe('emptyEventHistory', () => {
  it('reads nothing: an empty page and no latest event', async () => {
    expect(await emptyEventHistory.run()).toEqual([]);
    expect(await emptyEventHistory.context({ names: ['prompt'], after: '0:1', limit: 2 })).toEqual({
      events: [],
    });
    expect(await emptyEventHistory.latest(['checkpoint'])).toBeUndefined();
  });

  it.each(invalidReads)('context rejects %s', async (_, options, message) => {
    const error = await rejectionOf(() => emptyEventHistory.context(options as ReadContextOptions));

    expect(error.message).toMatch(message);
  });

  it('latest rejects invalid names', async () => {
    const error = await rejectionOf(() =>
      emptyEventHistory.latest('checkpoint' as unknown as readonly string[]),
    );

    expect(error.message).toMatch(/history\.latest: names must be an array/);
  });
});
