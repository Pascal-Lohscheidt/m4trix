import type { Clock } from 'effect';
import * as Duration from 'effect/Duration';
import type {
  AgentNetworkStore,
  AgentNetworkStoreKey,
  EventPage,
  ReadContextOptions,
  StoredEvent,
} from './agent-network-store.js';

/** Default `ttl` of the in-memory store: a context is dropped 30 minutes after its last event. */
export const DEFAULT_IN_MEMORY_STORE_TTL = '30 minutes';

/** Default `maxContexts` of the in-memory store. */
export const DEFAULT_IN_MEMORY_STORE_MAX_CONTEXTS = 1_000;

export type InMemoryNetworkStoreOptions = {
  /**
   * How long a context is kept after its last event; reads do not extend it. Default
   * `'30 minutes'`; `Infinity` keeps contexts until they are evicted.
   */
  ttl?: Duration.DurationInput;
  /**
   * Max contexts kept (the same `contextId` in two namespaces counts twice). A new context over
   * the cap evicts the least recently used one (read or written). Default 1000; `Infinity` for
   * no cap.
   */
  maxContexts?: number;
  /** Time source for `ttl`, e.g. a test clock. Defaults to the system clock. */
  clock?: Pick<Clock.Clock, 'unsafeCurrentTimeMillis'>;
};

/** One context's events. `generation` tells a recreated context apart from a deleted one. */
type ContextLog = {
  readonly id: string;
  readonly generation: number;
  readonly events: StoredEvent[];
  lastEventAt: number;
};

const keyOf = (key: AgentNetworkStoreKey): string => JSON.stringify([key.namespace, key.contextId]);

const systemClock = { unsafeCurrentTimeMillis: (): number => Date.now() };

function resolveTtlMillis(ttl: Duration.DurationInput): number {
  let millis: number;
  try {
    millis = Duration.toMillis(Duration.decode(ttl));
  } catch {
    millis = Number.NaN;
  }
  if (!(millis > 0)) {
    throw new Error(
      `createInMemoryNetworkStore: ttl must be a positive duration or Infinity, got ${String(ttl)}`,
    );
  }
  return millis;
}

function assertMaxContexts(maxContexts: number): void {
  if (
    !(
      maxContexts === Number.POSITIVE_INFINITY ||
      (Number.isInteger(maxContexts) && maxContexts > 0)
    )
  ) {
    throw new Error(
      `createInMemoryNetworkStore: maxContexts must be a positive integer or Infinity, got ${maxContexts}`,
    );
  }
}

/**
 * In-memory `AgentNetworkStore`, the default of every network. History lives in the process: it
 * is lost on restart and not shared between instances. Bounded by `ttl` and `maxContexts`;
 * expired contexts are dropped lazily (when read, or when another context is written), so it runs
 * no timers.
 */
export const createInMemoryNetworkStore = (
  options: InMemoryNetworkStoreOptions = {},
): AgentNetworkStore => {
  const ttlMillis = resolveTtlMillis(options.ttl ?? DEFAULT_IN_MEMORY_STORE_TTL);
  const maxContexts = options.maxContexts ?? DEFAULT_IN_MEMORY_STORE_MAX_CONTEXTS;
  assertMaxContexts(maxContexts);
  const clock = options.clock ?? systemClock;

  // Both maps hold every live context: `byUse` least recently used first, `byLastEvent` oldest
  // last event first, so eviction and expiry each look at the front only.
  const byUse = new Map<string, ContextLog>();
  const byLastEvent = new Map<string, ContextLog>();
  let generations = 0;

  const drop = (log: ContextLog): void => {
    byUse.delete(log.id);
    byLastEvent.delete(log.id);
  };

  const isExpired = (log: ContextLog, now: number): boolean => now - log.lastEventAt >= ttlMillis;

  /** The live log of `key`, marked as just used; expired logs are dropped on the way. */
  const use = (key: AgentNetworkStoreKey, now: number): ContextLog | undefined => {
    const id = keyOf(key);
    const log = byUse.get(id);
    if (!log) return undefined;
    if (isExpired(log, now)) {
      drop(log);
      return undefined;
    }
    byUse.delete(id);
    byUse.set(id, log);
    return log;
  };

  const dropExpired = (now: number): void => {
    for (const log of byLastEvent.values()) {
      if (!isExpired(log, now)) return;
      drop(log);
    }
  };

  /**
   * The position a cursor stands for: `generation:n` is the point after the log's first `n`
   * events. `undefined` for a cursor of a dropped log (deleted, expired or evicted).
   */
  const cursorPosition = (log: ContextLog, cursor: string): number | undefined => {
    const match = /^(\d+):(\d+)$/.exec(cursor);
    if (!match) throw new Error(`InMemoryNetworkStore: invalid cursor ${JSON.stringify(cursor)}`);
    if (Number(match[1]) !== log.generation) return undefined;
    return Math.min(Number(match[2]), log.events.length);
  };

  /** A page of the events at `positions`, with the cursor to older events when `more` remain. */
  const pageOf = (log: ContextLog, positions: readonly number[], more: boolean): EventPage => {
    const oldest = positions[0];
    const newest = positions[positions.length - 1];
    return {
      events: positions.map((position) => log.events[position] as StoredEvent),
      ...(more && { cursor: `${log.generation}:${oldest}` }),
      ...(newest !== undefined && { head: `${log.generation}:${newest + 1}` }),
    };
  };

  /** Positions of the log's events with one of `names`; every position without `names`. */
  const positionsOf = (log: ContextLog, names: readonly string[] | undefined): number[] =>
    log.events.flatMap((event, position) =>
      names === undefined || names.includes(event.name) ? [position] : [],
    );

  return {
    append: async (key, event) => {
      const now = clock.unsafeCurrentTimeMillis();
      dropExpired(now);
      let log = use(key, now);
      if (!log) {
        log = { id: keyOf(key), generation: generations++, events: [], lastEventAt: now };
        byUse.set(log.id, log);
        if (byUse.size > maxContexts) {
          const leastRecent = byUse.values().next().value;
          if (leastRecent) drop(leastRecent);
        }
      }
      log.events.push(event);
      log.lastEventAt = now;
      byLastEvent.delete(log.id);
      byLastEvent.set(log.id, log);
    },

    readRun: async (key, runId) =>
      (use(key, clock.unsafeCurrentTimeMillis())?.events ?? []).filter(
        (event) => event.meta.runId === runId,
      ),

    readContext: async (key, options: ReadContextOptions = {}): Promise<EventPage> => {
      const { limit, before, after } = options;
      if (after !== undefined && before !== undefined) {
        throw new Error('InMemoryNetworkStore: readContext takes after or before, not both');
      }
      const log = use(key, clock.unsafeCurrentTimeMillis());
      // Every cursor was handed out by a log, so `after` without one is a dropped log's.
      if (!log) return after === undefined ? { events: [] } : { events: [], reset: true };
      const positions = positionsOf(log, options.names);
      if (after !== undefined) {
        // A cursor of a dropped log: the new log is read from its start, flagged as a reset.
        const start = cursorPosition(log, after);
        const newer = positions.filter((position) => position >= (start ?? 0));
        const page = pageOf(log, limit === undefined ? newer : newer.slice(0, limit), false);
        return start === undefined ? { ...page, reset: true } : page;
      }
      const end = before === undefined ? log.events.length : cursorPosition(log, before);
      if (end === undefined) return { events: [] };
      const older = positions.filter((position) => position < end);
      const picked = limit === undefined ? older : older.slice(Math.max(0, older.length - limit));
      return pageOf(log, picked, picked.length < older.length);
    },

    readLatest: async (key, names) => {
      const log = use(key, clock.unsafeCurrentTimeMillis());
      if (!log) return undefined;
      for (let position = log.events.length - 1; position >= 0; position--) {
        const event = log.events[position] as StoredEvent;
        if (names.includes(event.name)) {
          return { event, cursor: `${log.generation}:${position + 1}` };
        }
      }
      return undefined;
    },

    deleteContext: async (key) => {
      const log = byUse.get(keyOf(key));
      if (log) drop(log);
    },
  };
};
