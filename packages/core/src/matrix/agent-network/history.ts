import {
  type AgentNetworkStore,
  type AgentNetworkStoreKey,
  type EventPage,
  principalNamespace,
  type ReadContextOptions,
  type StoredEvent,
} from './stores/agent-network-store.js';

/** What a history reads: one run of a context, in the namespace of the run's principal. */
export type HistoryScope = {
  readonly runId: string;
  readonly contextId: string;
  /** The run's principal (`meta.principalId`); absent for the anonymous namespace. */
  readonly principalId?: string;
};

/**
 * Durable event history of the current run and its context, read from the network's store on
 * demand. Transient events are never part of it. Scoped to the run's principal: another
 * principal's events under the same `contextId` are not visible.
 */
export type EventHistory = {
  /** The durable events of the current run so far, in publish order, its trigger included. */
  run(): Promise<readonly StoredEvent[]>;
  /**
   * A page of the context's durable events across its runs, oldest first: the newest `limit`
   * (all of them without one), before the `before` cursor when given. Pass the page's `cursor` as
   * `before` to read the page of older events; it is absent once the first event is reached.
   *
   * With `after` (a page's `head` or a `latest` cursor) it reads forward instead: the events
   * appended after that cursor, the oldest `limit` of them. Keep each page's `head` and read
   * `after` it next time to see only new events. `names` keeps only events with one of these
   * names; cursors still page the whole context, so filtered reads chain without gaps. `after`
   * and `before` together are an error. A page read `after` a cursor of a history that is gone
   * (the context was deleted or expired since) has `reset: true` and starts at the current
   * history's first event: drop whatever you derived from the old pages.
   */
  context(options?: ReadContextOptions): Promise<EventPage>;
  /**
   * The context's newest durable event with one of `names` (e.g. the latest checkpoint), and a
   * cursor at it: pass it as `after` to read only the events that followed. `undefined` when
   * there is none.
   */
  latest(
    names: readonly string[],
  ): Promise<{ readonly event: StoredEvent; readonly cursor: string } | undefined>;
};

/** The store key of a history scope (or an event's meta): its principal's namespace and context. */
export const storeKeyOf = (scope: {
  readonly contextId: string;
  readonly principalId?: string;
}): AgentNetworkStoreKey => ({
  namespace: principalNamespace(scope.principalId),
  contextId: scope.contextId,
});

function assertNames(names: unknown, method: string): void {
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new Error(`${method}: names must be an array of event names`);
  }
}

function assertReadContextOptions(options: ReadContextOptions | undefined): void {
  const limit = options?.limit;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error(`history.context: limit must be a positive integer, got ${String(limit)}`);
  }
  const before = options?.before;
  if (before !== undefined && typeof before !== 'string') {
    throw new Error('history.context: before must be a cursor string from an earlier page');
  }
  const after = options?.after;
  if (after !== undefined && typeof after !== 'string') {
    throw new Error('history.context: after must be a cursor string (a head or a latest cursor)');
  }
  if (after !== undefined && before !== undefined) {
    throw new Error('history.context: pass after or before, not both');
  }
  if (options?.names !== undefined) assertNames(options.names, 'history.context');
}

/** @internal The history of `scope`, read from `store`. */
export function createEventHistory(store: AgentNetworkStore, scope: HistoryScope): EventHistory {
  const key = storeKeyOf(scope);
  return {
    run: () => store.readRun(key, scope.runId),
    context: async (options) => {
      assertReadContextOptions(options);
      // No name matches an empty list; stores never see one.
      if (options?.names?.length === 0) return { events: [] };
      return store.readContext(key, options);
    },
    latest: async (names) => {
      assertNames(names, 'history.latest');
      if (names.length === 0) return undefined;
      if (store.readLatest) return store.readLatest(key, names);
      const { events, head } = await store.readContext(key, { names, limit: 1 });
      const [event] = events;
      if (event === undefined) return undefined;
      if (head === undefined) {
        throw new Error('history.latest: the store returned a non-empty page without a head');
      }
      return { event, cursor: head };
    },
  };
}

/** @internal History of an invocation outside a network: always empty. */
export const emptyEventHistory: EventHistory = {
  run: async () => [],
  context: async (options) => {
    assertReadContextOptions(options);
    return { events: [] };
  },
  latest: async (names) => {
    assertNames(names, 'history.latest');
    return undefined;
  },
};
