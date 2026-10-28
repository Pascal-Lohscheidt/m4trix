import { Either, type Schema as S } from 'effect';
import type { EnvelopeLike } from '../agent-network/agent-network-event.js';
import type { EventHistory } from '../agent-network/history.js';
import type { StoredEvent } from '../agent-network/stores/agent-network-store.js';
import {
  type AnyContextFold,
  ContextFold,
  type FoldReadStateOf,
  type FoldSkip,
  foldStoredEvents,
} from './context-fold.js';
import type { FoldCache, FoldCacheKey } from './fold-cache.js';
import {
  assertCompactable,
  encodeFoldCheckpointState,
  type FoldCheckpointPayload,
  type RestoredCheckpoint,
  restoreFoldCheckpoint,
} from './fold-checkpoint.js';
import { compactor, type FoldAccessor } from './fold-compaction.js';

/**
 * Reading folds: `ctx.folds.<name>()` folds the fold's events into its state, reusing the state
 * cached by earlier reads where there is one.
 */

/**
 * `ctx.folds` of an agent with the `.folds([...])` folds `TFolds`: one accessor per fold, by its
 * name. Calling it resolves to the fold's state, read-only (`FoldReadStateOf`) and frozen: in a
 * network it is the cached state itself, shared by every reader. Stored events are decoded with
 * their event's schema before they are folded; one that no longer decodes is left out and
 * reported (the network's logger and the `m4trix.fold.read.skipped` metric). Each call reads again
 * (folding the events published since the previous read), so read it after an `emitAndAwait` to
 * see what that changed. In a network, a read includes every event the invocation emitted before
 * it: it waits until they are stored, and rejects with `AgentAbortedError` when one never will be
 * (the run is over). To trim a state to a budget, pass it to a view (`ContextView.of`); to replace
 * it for good (a compaction), call its `compact` (see `FoldCompact`).
 */
export type FoldAccessors<TFolds extends AnyContextFold> = {
  readonly [F in TFolds as F['name']]: FoldAccessor<F>;
};

/**
 * `ctx.folds` of an aggregator: the read accessors of `FoldAccessors`, without `compact`
 * (compaction belongs in an agent, which has the layers to write a summary).
 */
export type FoldReadAccessors<TFolds extends AnyContextFold> = {
  readonly [F in TFolds as F['name']]: () => Promise<FoldReadStateOf<F>>;
};

/**
 * Reads a fold for `ctx.folds`: resolves to the fold's state. A network gives each invocation one
 * backed by its fold cache (`agent.invoke({ foldReader })`); pass your own to `invoke`, e.g. to
 * give an agent's folds fixed states in a test. Compacting is the runtime's: with your reader,
 * `folds.<name>.compact` rejects with `FoldCompactionError` (`'unsupported'`).
 */
export type FoldReader = (fold: AnyContextFold) => Promise<unknown>;

/**
 * @internal The runtime's reader: reads folds (`FoldReader`) and, in a network, compacts them.
 */
export interface CompactingFoldReader {
  /** Folds `fold`'s events (cached in a network) and resolves to its state. */
  (fold: AnyContextFold): Promise<unknown>;
  /**
   * Compacts `fold`: reads it, gets the new state from `next` (`undefined`: no compaction),
   * publishes it as the fold's checkpoint and resolves to the state a read returns afterwards.
   * Absent where nothing can be published (outside a network). Call `folds.<name>.compact`
   * instead: this is the runtime's side of it.
   */
  readonly compact?: (
    fold: AnyContextFold,
    next: (state: unknown) => Promise<{ readonly state: unknown } | undefined>,
  ) => Promise<{ readonly compacted: boolean; readonly state: unknown }>;
}

/** @internal A context-scoped state: the events up to `cursor` (`undefined`: none yet). */
type ContextEntry = { readonly state: unknown; readonly cursor: string | undefined };

/** @internal A run-scoped state: the run's first `count` events, the last being `lastEventId`. */
type RunEntry = {
  readonly state: unknown;
  readonly count: number;
  readonly lastEventId: string | undefined;
};

/** @internal What the fold cache keeps per (context or run, fold). */
export type FoldCacheEntry = ContextEntry | RunEntry;

/**
 * @internal One read, for metrics: `start` is `cold` (nothing cached), `warm` (continued a cached
 * state) or `reset` (the cached state was stale and rebuilt); `events` the events folded.
 */
export type FoldReadInfo = {
  readonly fold: string;
  readonly start: 'cold' | 'warm' | 'reset';
  readonly events: number;
};

/** @internal */
export type FoldReaderOptions = {
  /** The history folds read: the invocation's (`ctx.history`). */
  readonly history: EventHistory;
  /** Where read states are kept between reads; without it, every read folds from scratch. */
  readonly cache?: {
    readonly cache: FoldCache<FoldCacheEntry>;
    /** The invocation's run, context and store namespace (the cache key). */
    readonly scope: {
      readonly namespace: string;
      readonly contextId: string;
      readonly runId: string;
    };
    /** `false` once the run has ended: its run-scoped states are not kept any more. */
    readonly runActive: () => boolean;
  };
  readonly onRead?: (info: FoldReadInfo) => void;
  /**
   * A read left an event out of a fold, as if it was not there (see `FoldSkip`): a stored event
   * that does not decode with its event's schema, a checkpoint that cannot be restored (its
   * payload is not a checkpoint's, or its state does not decode with the fold's `state` schema),
   * or an event `attach` finds no segment for (`onMissing: 'report'`). Old history never breaks a
   * read. Each read reports what it skipped itself: a warm read never reports an event again.
   */
  readonly onSkip?: (skip: FoldSkip) => void;
  /**
   * Awaited before every read, when it returns a promise: in a network, the invocation's earlier
   * emits being stored (read-your-writes). A rejection rejects the read.
   */
  readonly beforeRead?: () => Promise<void> | undefined;
  /**
   * Publishes a fold's checkpoint (in a network: as an emit of the invocation, so the next read
   * waits for it through `beforeRead`). Without it, the reader cannot compact.
   */
  readonly publishCheckpoint?: (checkpoint: {
    readonly name: string;
    readonly payload: FoldCheckpointPayload;
  }) => void;
};

type FoldStep<E> = {
  readonly entry: E;
  readonly start: FoldReadInfo['start'];
  readonly events: number;
};

/** Rebases one read may make before it gives up on the store (see `foldContext`). */
const MAX_REBASES = 100;

/**
 * Brings a context-scoped state up to date: from `cached`, or cold (from the newest checkpoint,
 * else the initial state). The result is a function of the history alone, whatever was cached:
 *
 * - The newest usable checkpoint wins: its state, plus every event of the fold after its
 *   `through` (the cursor of the read it was computed from), folded again. So events published
 *   while a compaction ran are kept, and concurrent compactions resolve to the newest one.
 * - A page with a checkpoint rebases on it: when its `through` is the cursor the page was read
 *   after, the page holds exactly the events to fold on top; otherwise the events after `through`
 *   are read (again), and a newer checkpoint among them wins in turn.
 * - A page flagged `reset` means its cursor belongs to a history that is gone (deleted or expired,
 *   perhaps started over): the page holds the current history from its start, so the state is
 *   folded from the initial state over it. A checkpoint whose `through` is such a cursor was
 *   computed from the gone history: it is ignored, as are checkpoints that do not decode (those
 *   are reported to `onSkip`).
 * - Events are decoded with their event's schema (`foldStoredEvents`); one that does not decode is
 *   left out and reported to `onSkip`.
 */
async function foldContext(
  fold: AnyContextFold,
  history: EventHistory,
  cached: ContextEntry | undefined,
  onSkip: FoldReaderOptions['onSkip'],
): Promise<FoldStep<ContextEntry>> {
  const checkpointName = fold.checkpointEventName;
  const names =
    checkpointName === undefined ? fold.eventNames : [...fold.eventNames, checkpointName];
  // Each stored checkpoint is decoded (and reported) once per read, by its id: a store may hand
  // out a fresh object for it on every page.
  const decoded = new Map<unknown, RestoredCheckpoint | undefined>();
  const restore = (event: StoredEvent): RestoredCheckpoint | undefined => {
    const id = event.meta.eventId ?? event;
    if (decoded.has(id)) return decoded.get(id);
    const result = restoreFoldCheckpoint(fold.stateSchema as S.Schema.AnyNoContext, event);
    if (Either.isLeft(result)) {
      onSkip?.({ fold: fold.name, reason: 'checkpoint', event, error: result.left });
    }
    const checkpoint = Either.getOrUndefined(result);
    decoded.set(id, checkpoint);
    return checkpoint;
  };
  // Cursors of histories that are gone: a checkpoint computed after one of them is ignored.
  const stale = new Set<string | undefined>();
  const newestCheckpoint = (events: readonly StoredEvent[]): RestoredCheckpoint | undefined => {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index] as StoredEvent;
      if (event.name !== checkpointName) continue;
      const checkpoint = restore(event);
      if (checkpoint && !stale.has(checkpoint.through)) return checkpoint;
    }
    return undefined;
  };

  let start: FoldReadInfo['start'] = cached ? 'warm' : 'cold';
  let rebases = 0;
  let { state, cursor } = cached ?? { state: fold.initialState(), cursor: undefined };
  if (!cached && checkpointName !== undefined) {
    const latest = await history.latest([checkpointName]);
    const checkpoint = latest && restore(latest.event);
    if (checkpoint) ({ state, through: cursor } = checkpoint);
  }
  for (;;) {
    const page = await history.context({ names, ...(cursor !== undefined && { after: cursor }) });
    if (page.reset) {
      stale.add(cursor);
      start = 'reset';
      state = fold.initialState();
      cursor = undefined;
    }
    const checkpoint = newestCheckpoint(page.events);
    if (checkpoint && checkpoint.through !== cursor) {
      // Each rebase moves to a newer checkpoint, so a store that keeps its contract settles in a
      // few; one that does not would otherwise loop for ever.
      if (++rebases > MAX_REBASES) {
        throw new Error(
          `fold ${JSON.stringify(fold.name)}: a read rebased on ${MAX_REBASES} checkpoints ` +
            'without settling; the store returns pages that do not follow its cursors (see ' +
            'AgentNetworkStore.readContext).',
        );
      }
      // The events after its `through` are not (all) in this page: read them.
      ({ state, through: cursor } = checkpoint);
      continue;
    }
    const events: EnvelopeLike[] = page.events.filter((event) => event.name !== checkpointName);
    return {
      // An empty page has no head: keep the cursor.
      entry: {
        state: foldStoredEvents(fold, checkpoint ? checkpoint.state : state, events, onSkip),
        cursor: page.head ?? cursor,
      },
      start,
      events: events.length + (checkpoint ? 1 : 0),
    };
  }
}

/**
 * Brings a run-scoped state up to date with the run's events. The cached state continues only
 * when the run's stored events still begin with the ones it folded (same count, same last event);
 * otherwise (the context was deleted meanwhile) it is rebuilt.
 */
async function foldRun(
  fold: AnyContextFold,
  history: EventHistory,
  cached: RunEntry | undefined,
  onSkip: FoldReaderOptions['onSkip'],
): Promise<FoldStep<RunEntry>> {
  const all = await history.run();
  const continues =
    cached !== undefined &&
    cached.count <= all.length &&
    all[cached.count - 1]?.meta.eventId === cached.lastEventId;
  const unseen = continues ? all.slice(cached.count) : all;
  const relevant = unseen.filter((event) => fold.eventNames.includes(event.name));
  const base = continues ? cached.state : fold.initialState();
  return {
    entry: {
      state: foldStoredEvents(fold, base, relevant, onSkip),
      count: all.length,
      lastEventId: all[all.length - 1]?.meta.eventId,
    },
    start: continues ? 'warm' : cached ? 'reset' : 'cold',
    events: relevant.length,
  };
}

/**
 * Freezes the plain objects and arrays of a read state, deeply, so the read-only type
 * (`FoldReadStateOf`) holds at runtime: writing to it throws (strict mode). Other objects (a
 * `Date`, a `Map`, an `Option`, a schema class) are left as they are, and so is what they hold:
 * Effect caches hashes on its own data types, which freezing them would break. Stops at frozen
 * objects: what an earlier read froze (or a stored payload, frozen when it was appended) is not
 * walked again, so a warm read only freezes what it added.
 */
function freezeState(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) freezeState((value as Record<string, unknown>)[key]);
}

const foldStep = async (
  fold: AnyContextFold,
  history: EventHistory,
  cached: FoldCacheEntry | undefined,
  onSkip: FoldReaderOptions['onSkip'],
): Promise<FoldStep<FoldCacheEntry>> => {
  const step =
    fold.scope === 'run'
      ? await foldRun(fold, history, cached as RunEntry | undefined, onSkip)
      : await foldContext(fold, history, cached as ContextEntry | undefined, onSkip);
  // The read-only type holds at runtime (`FoldReadStateOf`).
  freezeState(step.entry.state);
  return step;
};

/**
 * A number per fold definition (object), handed out on its first read: with the fold's name (for
 * debugging), the fold's part of the cache key. Folds are told apart by identity, not by name, so
 * two different folds that share a name never share a state; agents that use one fold object
 * share it. Never reused, so an entry of a fold that was garbage collected is never read by
 * another one.
 */
const foldIds = new WeakMap<AnyContextFold, number>();
let lastFoldId = 0;

function foldId(fold: AnyContextFold): number {
  let id = foldIds.get(fold);
  if (id === undefined) {
    id = ++lastFoldId;
    foldIds.set(fold, id);
  }
  return id;
}

/**
 * @internal Reads folds over `history`. With a cache, a fold's state is cached per context (or
 * per run, for run-scoped folds) and fold object (see `foldId`), and each read only folds the
 * events published since; reads of one entry run one at a time, so an event is never folded
 * twice. Never memoized: every read asks the store for newer events. Resolves to the state
 * itself (the cached one, when nothing changed), shared by every reader.
 */
export function createFoldReader(options: FoldReaderOptions): CompactingFoldReader {
  const { history, cache, onRead, onSkip, beforeRead, publishCheckpoint } = options;
  const report = (fold: AnyContextFold, step: FoldStep<FoldCacheEntry>): void =>
    onRead?.({ fold: fold.name, start: step.start, events: step.events });

  /** Reads `fold`: its entry (state, and cursor or run position) after this read. */
  const readEntry = async (fold: AnyContextFold): Promise<FoldCacheEntry> => {
    // With nothing to wait for, the read starts right away.
    const pending = beforeRead?.();
    if (pending) await pending;
    if (!cache) {
      const step = await foldStep(fold, history, undefined, onSkip);
      report(fold, step);
      return step.entry;
    }
    const { namespace, contextId, runId } = cache.scope;
    const run = fold.scope === 'run';
    const id = foldId(fold);
    const key: FoldCacheKey = run
      ? { id: JSON.stringify(['run', namespace, contextId, runId, fold.name, id]), runId }
      : { id: JSON.stringify(['context', namespace, contextId, fold.name, id]) };
    return cache.cache.update(key, async (cached) => {
      const step = await foldStep(fold, history, cached, onSkip);
      report(fold, step);
      const keep = !run || cache.runActive();
      return { entry: keep ? step.entry : undefined, result: step.entry };
    });
  };
  const read: FoldReader = async (fold) => (await readEntry(fold)).state;
  if (!publishCheckpoint) return read;

  const compact: CompactingFoldReader['compact'] = async (fold, next) => {
    assertCompactable(fold);
    // `through` is the cursor of this very read: the state `next` gets covers exactly the
    // events up to it, and a read of the checkpoint folds every later one again.
    const { state, cursor } = (await readEntry(fold)) as ContextEntry;
    const proposal = await next(state);
    if (!proposal) return { compacted: false, state };
    publishCheckpoint({
      name: fold.checkpointEventName,
      payload: {
        fold: fold.name,
        version: fold.version,
        through: cursor ?? null,
        state: encodeFoldCheckpointState(fold, proposal.state),
      },
    });
    return { compacted: true, state: await read(fold) };
  };
  return Object.assign(read, { compact });
}

/**
 * @internal `ctx.folds`: an accessor per fold, each reading it with `reader`; for an agent, each
 * with `compact` (see `FoldCompact`); `{ compact: false }` for an aggregator's read accessors.
 */
export function foldAccessors<TFolds extends AnyContextFold>(
  folds: ReadonlyArray<TFolds>,
  reader: CompactingFoldReader,
): FoldAccessors<TFolds>;
export function foldAccessors<TFolds extends AnyContextFold>(
  folds: ReadonlyArray<TFolds>,
  reader: CompactingFoldReader,
  options: { readonly compact: false },
): FoldReadAccessors<TFolds>;
export function foldAccessors(
  folds: ReadonlyArray<AnyContextFold>,
  reader: CompactingFoldReader,
  options?: { readonly compact: false },
): Record<string, () => Promise<unknown>> {
  const accessors: Record<string, () => Promise<unknown>> = {};
  for (const fold of folds) {
    const read = () => reader(fold);
    accessors[fold.name] =
      options?.compact === false
        ? read
        : Object.freeze(Object.assign(read, { compact: compactor(fold, reader) }));
  }
  return Object.freeze(accessors);
}

/** Type-level marker: two folds of one agent have this name (their accessor in `ctx.folds`). */
export interface DuplicateFoldName<Name extends string> {
  /** The name used by more than one fold, shown in the type error. */
  readonly 'fold names must be unique per agent; used twice': Name;
}

/** Names in `Folds` that are in `Taken` or appear earlier in `Folds`. */
type DuplicateNames<
  Folds extends ReadonlyArray<unknown>,
  Taken extends string,
> = Folds extends readonly [infer Head, ...infer Tail]
  ? Head extends { readonly name: infer Name extends string }
    ? (Name extends Taken ? Name : never) | DuplicateNames<Tail, Taken | Name>
    : DuplicateNames<Tail, Taken>
  : never;

/**
 * `Folds` when their names are unique and not in `Taken` (the names of earlier `.folds()`
 * calls); otherwise `Folds` with each duplicate replaced by `DuplicateFoldName`, so passing them
 * is a type error at the duplicate.
 */
export type UniqueFolds<Folds extends ReadonlyArray<AnyContextFold>, Taken extends string> = [
  DuplicateNames<Folds, Taken>,
] extends [never]
  ? Folds
  : {
      readonly [K in keyof Folds]: Folds[K] extends {
        readonly name: infer Name extends DuplicateNames<Folds, Taken>;
      }
        ? DuplicateFoldName<Name>
        : Folds[K];
    };

/**
 * @internal `existing` plus `added`, each validated (`ContextFold.validate`: folds only, a view is
 * rejected with a hint). Throws on a name used twice (accessor names must be unique). Different
 * folds that share a name are accepted here (state is cached per fold object); the network's
 * wiring check fails setup when they would share checkpoints (`fold-checkpoint-shared`: both
 * compactable, same name and version) and warns otherwise (`fold-name-shared`).
 */
export function addFolds(
  existing: ReadonlyArray<AnyContextFold>,
  added: ReadonlyArray<unknown>,
  caller: string,
): ReadonlyArray<AnyContextFold> {
  if (!Array.isArray(added)) {
    throw new Error(`${caller}: pass an array of folds, e.g. .folds([Conversation])`);
  }
  const all = [...existing];
  for (const fold of added) {
    ContextFold.validate(fold);
    const { name } = fold;
    if (all.some((other) => other.name === name)) {
      throw new Error(
        `${caller}: two folds are named "${name}"; each needs its own name, its accessor in ` +
          'ctx.folds',
      );
    }
    all.push(fold);
  }
  return all;
}
