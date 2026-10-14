import type { EventHistory } from '../agent-network/history.js';
import {
  type AnyContextFold,
  ContextFold,
  type FoldResultOf,
  type FoldSource,
} from './context-fold.js';
import type { FoldCache, FoldCacheKey } from './fold-cache.js';

/**
 * Reading folds: `ctx.folds.<name>()` folds the source's events into its state, reusing the
 * state cached by earlier reads where there is one, then applies the source's `select`.
 */

/**
 * `ctx.folds` of an agent or aggregator with the `.folds([...])` sources `TFolds`: one accessor
 * per source, by its name. Each call reads again (folding the events published since the
 * previous read), so read it after an `emitAndAwait` to see what that changed. In a network, a
 * read includes every event the invocation emitted before it: it waits until they are stored, and
 * rejects with `AgentAbortedError` when one never will be (the run is over).
 */
export type FoldAccessors<TFolds extends FoldSource> = {
  readonly [S in TFolds as S['name']]: () => Promise<FoldResultOf<S>>;
};

/** Reads one source: folds its fold's events (cached in a network), then selects. */
export type FoldReader = (source: FoldSource) => Promise<unknown>;

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
};

type FoldStep<E> = {
  readonly entry: E;
  readonly start: FoldReadInfo['start'];
  readonly events: number;
};

/**
 * Brings a context-scoped state up to date: from `entry`, or cold (from the newest checkpoint,
 * else the initial state). A page flagged `reset` means the cursor belongs to a history that is
 * gone (deleted or expired, perhaps started over): the page holds the current history from its
 * start, so the state is folded from the initial state over it. Folding from the start equals
 * starting at its newest checkpoint, since a checkpoint replaces the state.
 */
async function foldContext(
  fold: AnyContextFold,
  history: EventHistory,
  cached: ContextEntry | undefined,
): Promise<FoldStep<ContextEntry>> {
  let entry = cached;
  let events = 0;
  if (!entry) {
    entry = { state: fold.initialState(), cursor: undefined };
    if (fold.checkpointEventName !== undefined) {
      const latest = await history.latest([fold.checkpointEventName]);
      if (latest) {
        entry = { state: fold.apply(entry.state, latest.event), cursor: latest.cursor };
        events = 1;
      }
    }
  }
  const page = await history.context({
    names: fold.eventNames,
    ...(entry.cursor !== undefined && { after: entry.cursor }),
  });
  if (page.reset) {
    return {
      entry: { state: fold.applyAll(fold.initialState(), page.events), cursor: page.head },
      start: 'reset',
      events: page.events.length,
    };
  }
  return {
    // An empty page has no head: keep the cursor.
    entry: { state: fold.applyAll(entry.state, page.events), cursor: page.head ?? entry.cursor },
    start: cached ? 'warm' : 'cold',
    events: events + page.events.length,
  };
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
      state: fold.applyAll(base, relevant),
      count: all.length,
      lastEventId: all[all.length - 1]?.meta.eventId,
    },
    start: continues ? 'warm' : cached ? 'reset' : 'cold',
    events: relevant.length,
  };
}

const foldStep = (
  fold: AnyContextFold,
  history: EventHistory,
  cached: FoldCacheEntry | undefined,
): Promise<FoldStep<FoldCacheEntry>> =>
  fold.scope === 'run'
    ? foldRun(fold, history, cached as RunEntry | undefined)
    : foldContext(fold, history, cached as ContextEntry | undefined);

/**
 * @internal Reads sources over `history`. With a cache, a fold's state is cached per context (or
 * per run, for run-scoped folds) and fold (`name` + `version`), and each read only folds the
 * events published since; reads of one entry run one at a time, so an event is never folded
 * twice. Never memoized: every read asks the store for newer events.
 */
export function createFoldReader(options: FoldReaderOptions): FoldReader {
  const { history, cache, onRead } = options;
  const report = (fold: AnyContextFold, step: FoldStep<FoldCacheEntry>): void =>
    onRead?.({ fold: fold.name, start: step.start, events: step.events });

  return async (source) => {
    const { fold } = source;
    let state: unknown;
    if (!cache) {
      const step = await foldStep(fold, history, undefined);
      report(fold, step);
      state = step.entry.state;
    } else {
      const { namespace, contextId, runId } = cache.scope;
      const run = fold.scope === 'run';
      const key: FoldCacheKey = run
        ? {
            id: JSON.stringify(['run', namespace, contextId, runId, fold.name, fold.version]),
            runId,
          }
        : { id: JSON.stringify(['context', namespace, contextId, fold.name, fold.version]) };
      state = await cache.cache.update(key, async (cached) => {
        const step = await foldStep(fold, history, cached);
        report(fold, step);
        const keep = !run || cache.runActive();
        return { entry: keep ? step.entry : undefined, result: step.entry.state };
      });
    }
    return source.select(state);
  };
}

/** @internal `ctx.folds`: an accessor per source, each reading it with `reader`. */
export function foldAccessors<TFolds extends FoldSource>(
  sources: ReadonlyArray<TFolds>,
  reader: FoldReader,
): FoldAccessors<TFolds> {
  const accessors: Record<string, () => Promise<unknown>> = {};
  for (const source of sources) accessors[source.name] = () => reader(source);
  return Object.freeze(accessors) as FoldAccessors<TFolds>;
}

/**
 * Type-level marker: two sources of one agent have this name (a fold and a view of it need
 * different names: `Conversation.view('chat', …)`).
 */
export interface DuplicateFoldName<Name extends string> {
  /** The name used by more than one source, shown in the type error. */
  readonly 'fold source names must be unique per agent; used twice': Name;
}

/** Names in `Sources` that are in `Taken` or appear earlier in `Sources`. */
type DuplicateNames<
  Sources extends ReadonlyArray<unknown>,
  Taken extends string,
> = Sources extends readonly [infer Head, ...infer Tail]
  ? Head extends { readonly name: infer Name extends string }
    ? (Name extends Taken ? Name : never) | DuplicateNames<Tail, Taken | Name>
    : DuplicateNames<Tail, Taken>
  : never;

/**
 * `Sources` when their names are unique and not in `Taken` (the names of earlier `.folds()`
 * calls); otherwise `Sources` with each duplicate replaced by `DuplicateFoldName`, so passing them
 * is a type error at the duplicate.
 */
export type UniqueFoldSources<Sources extends ReadonlyArray<FoldSource>, Taken extends string> = [
  DuplicateNames<Sources, Taken>,
] extends [never]
  ? Sources
  : {
      readonly [K in keyof Sources]: Sources[K] extends {
        readonly name: infer Name extends DuplicateNames<Sources, Taken>;
      }
        ? DuplicateFoldName<Name>
        : Sources[K];
    };

/**
 * @internal `existing` plus `added`, each validated (`ContextFold.validate`). Throws on a name
 * used twice (accessor names must be unique) and on two different folds with the same name and
 * version (they would share cached state).
 */
export function addFoldSources(
  existing: ReadonlyArray<FoldSource>,
  added: ReadonlyArray<unknown>,
  caller: string,
): ReadonlyArray<FoldSource> {
  if (!Array.isArray(added)) {
    throw new Error(`${caller}: pass an array of folds and views, e.g. .folds([Conversation])`);
  }
  const all = [...existing];
  for (const source of added) {
    ContextFold.validate(source);
    const { name, fold } = source;
    if (all.some((other) => other.name === name)) {
      throw new Error(
        `${caller}: two fold sources are named "${name}"; each needs its own name, its accessor ` +
          'in ctx.folds (give a view a name of its own)',
      );
    }
    const clash = all.find(
      (other) =>
        other.fold !== fold && other.fold.name === fold.name && other.fold.version === fold.version,
    );
    if (clash) {
      throw new Error(
        `${caller}: "${name}" reads a different fold named "${fold.name}" (version ${fold.version}) ` +
          `than "${clash.name}"; folds are cached by name and version, so give one another name ` +
          'or version',
      );
    }
    all.push(source);
  }
  return all;
}
