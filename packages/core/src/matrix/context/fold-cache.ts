import type { Clock } from 'effect';
import * as Duration from 'effect/Duration';

/** Default `foldCache.maxEntries`: folded states kept per event plane. */
export const DEFAULT_FOLD_CACHE_MAX_ENTRIES = 1_000;

/**
 * Default `foldCache.ttl`: a folded state is dropped 30 minutes after it was last read, matching
 * the in-memory store's default `ttl`.
 */
export const DEFAULT_FOLD_CACHE_TTL = '30 minutes';

/**
 * Bounds of the cache of folded state (`AgentNetwork.setup(cb, { foldCache })`). Each event
 * plane keeps one, holding one state per (context or run, fold); a dropped state is rebuilt on its
 * next read, from the newest checkpoint when the fold has one. The bounds only limit memory:
 * results never depend on them, since a state is always brought up to date with the store before
 * it is read, and a state of a context that was deleted or expired since is rebuilt (the store
 * reports its cursor as stale, see `EventPage.reset`).
 */
export type FoldCacheOptions = {
  /**
   * Max folded states kept; storing one more evicts the least recently read. Default 1000;
   * `Infinity` for no cap.
   */
  maxEntries?: number;
  /**
   * How long a folded state is kept after it was last read. Default `'30 minutes'`; `Infinity`
   * keeps states until they are evicted. Expired states are dropped lazily, so there are no timers.
   */
  ttl?: Duration.DurationInput;
  /** Time source for `ttl`, e.g. a test clock. Defaults to the system clock. */
  clock?: Pick<Clock.Clock, 'unsafeCurrentTimeMillis'>;
};

/** @internal `FoldCacheOptions` with defaults filled in. */
export type ResolvedFoldCacheOptions = {
  readonly maxEntries: number;
  readonly ttlMillis: number;
  readonly clock: Pick<Clock.Clock, 'unsafeCurrentTimeMillis'>;
};

/** @internal Identifies a cached state; `runId` for state that is dropped when the run ends. */
export type FoldCacheKey = { readonly id: string; readonly runId?: string };

/** @internal A bounded cache whose updates of one key run one at a time. */
export type FoldCache<V> = {
  /**
   * Runs `update` with the key's entry (`undefined` when there is none, or it expired) once the
   * key's earlier updates have settled, then stores the entry it returns (`undefined` removes it)
   * and resolves with its `result`. A rejected `update` leaves the entry as it was. So concurrent
   * reads of one key never fold an event twice: each one starts from the state the previous one
   * left.
   */
  update<R>(
    key: FoldCacheKey,
    update: (
      entry: V | undefined,
    ) => Promise<{ readonly entry: V | undefined; readonly result: R }>,
  ): Promise<R>;
  /** Removes the entries stored with `runId` (when the run ends). */
  dropRun(runId: string): void;
  /** Entries held, expired ones not dropped yet included. */
  size(): number;
};

const PREFIX = 'AgentNetwork.setup: foldCache';

const systemClock = { unsafeCurrentTimeMillis: (): number => Date.now() };

/** @internal Validates `options` (throws on invalid values) and fills in the defaults. */
export function resolveFoldCacheOptions(
  options: FoldCacheOptions | undefined,
): ResolvedFoldCacheOptions {
  const maxEntries = options?.maxEntries ?? DEFAULT_FOLD_CACHE_MAX_ENTRIES;
  if (
    !(maxEntries === Number.POSITIVE_INFINITY || (Number.isInteger(maxEntries) && maxEntries > 0))
  ) {
    throw new Error(
      `${PREFIX}.maxEntries must be a positive integer or Infinity, got ${maxEntries}`,
    );
  }
  const ttl = options?.ttl ?? DEFAULT_FOLD_CACHE_TTL;
  let ttlMillis: number;
  try {
    ttlMillis = Duration.toMillis(Duration.decode(ttl));
  } catch {
    ttlMillis = Number.NaN;
  }
  if (!(ttlMillis > 0)) {
    throw new Error(`${PREFIX}.ttl must be a positive duration or Infinity, got ${String(ttl)}`);
  }
  return { maxEntries, ttlMillis, clock: options?.clock ?? systemClock };
}

type Slot<V> = { readonly value: V; readonly lastUsed: number; readonly runId?: string };

/** @internal A fold cache bounded by `options` (see `FoldCacheOptions`). */
export function createFoldCache<V>(options?: FoldCacheOptions): FoldCache<V> {
  const { maxEntries, ttlMillis, clock } = resolveFoldCacheOptions(options);
  // Least recently used first. Every use stores the entry again (moving it to the end), so the
  // entries are also ordered by last use: expired ones are at the front.
  const slots = new Map<string, Slot<V>>();
  const runs = new Map<string, Set<string>>();
  // The latest update of each key; the next one waits for it.
  const locks = new Map<string, Promise<void>>();

  const remove = (id: string): void => {
    const slot = slots.get(id);
    if (!slot) return;
    slots.delete(id);
    if (slot.runId === undefined) return;
    const ids = runs.get(slot.runId) as Set<string>;
    ids.delete(id);
    if (ids.size === 0) runs.delete(slot.runId);
  };

  const isExpired = (slot: Slot<V>, now: number): boolean => now - slot.lastUsed >= ttlMillis;

  const get = (id: string, now: number): V | undefined => {
    const slot = slots.get(id);
    if (!slot) return undefined;
    if (!isExpired(slot, now)) return slot.value;
    remove(id);
    return undefined;
  };

  const set = (key: FoldCacheKey, value: V, now: number): void => {
    remove(key.id);
    for (const [id, slot] of slots) {
      if (!isExpired(slot, now)) break;
      remove(id);
    }
    slots.set(key.id, {
      value,
      lastUsed: now,
      ...(key.runId !== undefined && { runId: key.runId }),
    });
    if (key.runId !== undefined) {
      const ids = runs.get(key.runId) ?? new Set<string>();
      ids.add(key.id);
      runs.set(key.runId, ids);
    }
    if (slots.size > maxEntries) remove(slots.keys().next().value as string);
  };

  return {
    async update(key, update) {
      const previous = locks.get(key.id);
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(key.id, done);
      await previous;
      try {
        const { entry, result } = await update(get(key.id, clock.unsafeCurrentTimeMillis()));
        if (entry === undefined) remove(key.id);
        else set(key, entry, clock.unsafeCurrentTimeMillis());
        return result;
      } finally {
        if (locks.get(key.id) === done) locks.delete(key.id);
        release();
      }
    },
    dropRun(runId) {
      for (const id of runs.get(runId) ?? []) remove(id);
    },
    size: () => slots.size,
  };
}
