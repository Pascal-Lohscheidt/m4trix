import type { EventEnvelope } from '../agent-factory.js';
import type {
  AgentNetworkEventDef,
  EnvelopeLike,
  S,
} from '../agent-network/agent-network-event.js';
import {
  type ContextView,
  createView,
  isSegmentedState,
  type RuntimeViewOptions,
  type ViewOptions,
} from './view.js';

/**
 * Context folds: a typed, incremental view of a conversation. A fold reduces the events of a
 * context (or of one run) into a state with pure handlers, so an agent reads `folds.conversation()`
 * instead of re-reading and re-assembling `history.context()` on every step. This file holds the
 * definition only; the runtime (`.folds()`, the plane cache) folds and caches the state.
 */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/**
 * Which events a fold reads: `'context'` (default) folds every run of the context, so the state
 * spans a whole conversation; `'run'` folds the current run only (e.g. progress of one request).
 */
export type FoldScope = 'context' | 'run';

/** Options of `ContextFold.of(name, options)`. */
export type ContextFoldOptions = {
  /**
   * Positive integer, part of the cache identity (`name` + `version`). Bump it whenever the
   * handlers or the state shape change, so state cached by an older definition is not reused.
   */
  readonly version: number;
};

/**
 * A fold definition is invalid: a name that is not a JS identifier, a version that is not a
 * positive integer, an `over()` that is empty or lists an event twice, a handler or checkpoint for
 * an event outside `over()` or for an event that is already handled, a second checkpoint event, an
 * `over()` event without a handler, or a missing `initial()`. See `ContextFold.validate` for when
 * each is reported.
 */
export class ContextFoldDefinitionError extends Error {
  /** Discriminant for `catch` / Effect error handling. */
  readonly _tag = 'ContextFoldDefinitionError' as const;
  /** Name of the fold (or, for a view, its fold) whose definition is invalid. */
  readonly foldName: string;

  constructor(foldName: string, message: string) {
    super(message);
    this.name = 'ContextFoldDefinitionError';
    this.foldName = foldName;
  }
}

/**
 * A source `ctx.folds` can read (`.folds([...])`): a `ContextFold` itself (identity `select`), or
 * a view of one. The runtime folds `fold`'s events into its (cached) state, then calls `select`.
 */
export interface FoldSource<Name extends string = string, Result = unknown> {
  /** Accessor name in `ctx.folds` (a JS identifier): `folds[name]()`. */
  readonly name: Name;
  /** The fold whose cached state is read; the cache identity is `fold.name` + `fold.version`. */
  readonly fold: AnyContextFold;
  /** Derives the result from the fold's state (identity for a fold). */
  select(state: unknown): Result | Promise<Result>;
}

type CharsOf<
  Text extends string,
  Chars extends string = never,
> = Text extends `${infer Head}${infer Rest}` ? CharsOf<Rest, Chars | Head> : Chars;
type Letter = CharsOf<'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'>;
type IdentifierStart = Letter | '_' | '$';
type IdentifierPart = IdentifierStart | CharsOf<'0123456789'>;
type IsIdentifierRest<Text extends string> = Text extends `${infer Head}${infer Rest}`
  ? Head extends IdentifierPart
    ? IsIdentifierRest<Rest>
    : false
  : true;
/** The runtime name rule at type level; a non-literal `string` passes (checked at runtime). */
type IsFoldName<Name extends string> = string extends Name
  ? true
  : Name extends '__proto__'
    ? false
    : Name extends `${infer Head}${infer Rest}`
      ? Head extends IdentifierStart
        ? IsIdentifierRest<Rest>
        : false
      : false;

/** Type-level marker of a name that is not a JS identifier (see `ValidFoldName`). */
export interface InvalidFoldName<Name extends string> {
  /** The rejected name, shown in the type error. */
  readonly 'a fold or view name must be a JS identifier': Name;
}

/**
 * `unknown` for a valid fold / view name, else `InvalidFoldName<Name>`. Intersected with a name
 * parameter (`name: Name & ValidFoldName<Name>`), it turns a literal name that is not a JS
 * identifier into a type error at the call.
 */
export type ValidFoldName<Name extends string> =
  IsFoldName<Name> extends true ? unknown : InvalidFoldName<Name>;

declare const missingHandlers: unique symbol;

/**
 * Type-level marker of an incomplete fold: `EventName` still needs an `.on()` handler (or to be
 * the `.checkpointOn()` event) before the fold is an `AnyContextFold` / `FoldSource`.
 */
export interface MissingFoldHandlers<EventName extends string> {
  /** The `over()` events without a handler, shown in the type error. */
  readonly 'add an .on() handler (or .checkpointOn()) for': EventName;
}

/**
 * A complete fold of any state, as the runtime sees it (and a `FoldSource` of its own state). An
 * incomplete fold is not assignable to it: its `[missingHandlers]` is not `never`.
 */
export interface AnyContextFold extends FoldSource<string, unknown> {
  /** See `ContextFoldOptions.version`: part of the cache identity with `name`. */
  readonly version: number;
  /** Which events the fold reads: the whole context or the current run. */
  readonly scope: FoldScope;
  /** Names of every `over()` event, the checkpoint event included: the events to read. */
  readonly eventNames: ReadonlyArray<string>;
  /** The `.checkpointOn()` event, if any: a cold read starts at the newest one. */
  readonly checkpointEventName: string | undefined;
  /** A fresh initial state (`initial()`). */
  initialState(): unknown;
  /** Folds one stored event (see `ContextFold#apply`). */
  apply(state: unknown, event: EnvelopeLike): unknown;
  /** Folds `events` in order (oldest first), starting from `state`. */
  applyAll(state: unknown, events: Iterable<EnvelopeLike>): unknown;
  /** `never` once every `over()` event is handled. */
  readonly [missingHandlers]: never;
}

/** State type of a fold (what `initial()` and its handlers return). */
export type FoldStateOf<F> = F extends { initialState(): infer State } ? State : never;

/** What reading a source from `ctx.folds` resolves to: its `select` result, awaited. */
export type FoldResultOf<Source> = Source extends { select(state: never): infer Result }
  ? Awaited<Result>
  : never;

type MissingOf<Over extends EventDef, Done extends string> = [Exclude<Over['name'], Done>] extends [
  never,
]
  ? never
  : MissingFoldHandlers<Exclude<Over['name'], Done>>;

/** The `over()` events that are neither handled nor the checkpoint event yet. */
type Unhandled<Over extends EventDef, Done extends string> = Exclude<Over, { readonly name: Done }>;

/** `ContextFold.of(name, options)`: choose the scope, then the folded events. */
export interface ContextFoldBuilder<Name extends string, Scope extends FoldScope = 'context'> {
  /** Folds every run of the context (`'context'`, the default) or the current run (`'run'`). */
  scope<const NextScope extends FoldScope>(scope: NextScope): ContextFoldBuilder<Name, NextScope>;
  /**
   * The events the fold reads (at least one, each once). Every one needs an `.on()` handler or
   * must be the `.checkpointOn()` event before the fold can be used.
   */
  over<const E extends EventDef>(
    events: ReadonlyArray<E>,
  ): ContextFoldEventsBuilder<Name, Scope, E>;
}

/** After `over()`: the scope can still change; `initial()` makes it a fold. */

export interface ContextFoldEventsBuilder<
  Name extends string,
  Scope extends FoldScope,
  Over extends EventDef,
> {
  /** Folds every run of the context (`'context'`, the default) or the current run (`'run'`). */
  scope<const NextScope extends FoldScope>(
    scope: NextScope,
  ): ContextFoldEventsBuilder<Name, NextScope, Over>;
  /**
   * The state before any event, created on every cold start (so return a fresh value). Its
   * return type is the fold's state type: annotate it when inference would be too narrow, e.g.
   * `.initial((): Conversation => ({ turns: [] }))` or `.initial<readonly string[]>(() => [])`.
   */
  initial<State>(initial: () => State): ContextFold<Name, Scope, Over, State>;
}

/**
 * A fold over the `Over` events into `State`. `Handled` and `Checkpoint` track, at type level,
 * which events have a handler: until every `over()` event is one of them, the fold is not an
 * `AnyContextFold` / `FoldSource` (see `MissingFoldHandlers`), and at runtime it throws
 * `ContextFoldDefinitionError` on first use.
 *
 * Handlers are **pure** `(state, envelope) => state`: no I/O, no mutation of `state` (return a new
 * value), no clock or randomness. The same events must always fold to the same state; the runtime
 * caches folded state and folds only newer events into it, so it relies on that.
 *
 * A fold is its own `FoldSource` (`fold.fold === fold`, `select` is the identity).
 */

export interface ContextFold<
  Name extends string,
  Scope extends FoldScope,
  Over extends EventDef,
  State,
  Handled extends string = never,
  Checkpoint extends string = never,
> {
  /** Fold name, also its accessor in `ctx.folds` (a JS identifier). */
  readonly name: Name;
  /** See `ContextFoldOptions.version`. */
  readonly version: number;
  /** Which events the fold reads: the whole context (`'context'`) or the current run (`'run'`). */
  readonly scope: Scope;
  /** Names of every `over()` event, the checkpoint event included: the events to read. */
  readonly eventNames: ReadonlyArray<Over['name']>;
  /** The `.checkpointOn()` event, if any: a cold read starts at the newest one. */
  readonly checkpointEventName: [Checkpoint] extends [never] ? undefined : Checkpoint;
  /** A fold is its own source. */
  readonly fold: ContextFold<Name, Scope, Over, State, Handled, Checkpoint>;
  /** Identity: reading a fold yields its state. */
  select(state: State): State;
  /** Type-only: `never` once complete, else `MissingFoldHandlers<the unhandled event names>`. */
  readonly [missingHandlers]: MissingOf<Over, Handled | Checkpoint>;
  /** A fresh initial state (`initial()`). */
  initialState(): State;
  /**
   * Folds one stored event: the checkpoint event replaces the state with `restore(envelope)`, a
   * handled event runs its handler, any other event returns `state` unchanged. Events are not
   * decoded again (stored events were validated when published).
   */
  apply(state: State, event: EnvelopeLike): State;
  /** Folds `events` in order (oldest first), starting from `state`. */
  applyAll(state: State, events: Iterable<EnvelopeLike>): State;
  /**
   * Handles `event` (one of `over()`, not handled yet): `handler` gets the current state and the
   * typed envelope and returns the next state, without mutating the current one.
   */
  on<E extends Unhandled<Over, Handled | Checkpoint>>(
    event: E,
    handler: (state: State, envelope: EventEnvelope<E>) => State,
  ): ContextFold<Name, Scope, Over, State, Handled | E['name'], Checkpoint>;
  /**
   * Makes `event` (one of `over()`, not handled yet) the checkpoint: applying it **replaces** the
   * state with `restore(envelope)`, so the checkpoint payload must carry everything the state
   * keeps (e.g. a summary of the turns it compacts). A cold read starts at the newest checkpoint
   * and folds only the events after it. Events published between a compactor reading the fold
   * and its checkpoint being published are not in the checkpoint: compact while the context is
   * quiet (e.g. via `emitAndAwait` from the only active agent). At most one per fold.
   */
  checkpointOn: [Checkpoint] extends [never]
    ? <E extends Unhandled<Over, Handled>>(
        event: E,
        restore: (envelope: EventEnvelope<E>) => State,
      ) => ContextFold<Name, Scope, Over, State, Handled, E['name']>
    : CheckpointAlreadyDeclared<Checkpoint>;
  /**
   * A named, budgeted view of this fold: a `FoldSource` of its own (`.folds([view])` →
   * `folds[name]()`) that reads this fold's (cached) state and runs `strategies` over it, in
   * order, each at most once and only while its tokens exceed `budget`. Resolves to a
   * `ViewResult`: the trimmed state plus `{ tokens, budget, overBudget, dropped }`.
   *
   * A segmented fold (`SegmentedFold`) counts per segment (`count`, default `approxTokenCount`)
   * plus its checkpoint (`countCheckpoint`), and takes segment strategies (`ContextStrategy`);
   * any other fold needs `measure(state)` for its whole state and strategies of its state type.
   * `budget` is a positive integer or `Infinity` (no budget); `name` is a JS identifier.
   *
   * ```ts
   * const ChatView = Conversation.view('chat', {
   *   budget: 50_000,
   *   strategies: [
   *     ContextStrategy.elide({ olderThan: 6, map: truncateToolOutputs }),
   *     ContextStrategy.dropOldest({ pin }),
   *   ],
   * });
   * ```
   *
   * Only available once the fold is complete (every `over()` event handled).
   */
  view: [MissingOf<Over, Handled | Checkpoint>] extends [never]
    ? <const ViewName extends string>(
        name: ViewName & ValidFoldName<ViewName>,
        options: ViewOptions<State>,
      ) => ContextView<ViewName, State>
    : MissingOf<Over, Handled | Checkpoint>;
}

/** `checkpointOn()` was already called: a fold has at most one checkpoint event. */
export interface CheckpointAlreadyDeclared<Checkpoint extends string> {
  /** The checkpoint event already declared, shown in the type error. */
  readonly 'a fold has one checkpoint event, already declared': Checkpoint;
}

type Handler = (state: unknown, envelope: EnvelopeLike) => unknown;
type Restore = (envelope: EnvelopeLike) => unknown;

type Definition = {
  readonly name: string;
  readonly version: number;
  readonly scope: FoldScope;
  readonly events: ReadonlyArray<EventDef>;
  readonly initial?: () => unknown;
  readonly handlers: ReadonlyMap<string, Handler>;
  readonly checkpoint?: { readonly eventName: string; readonly restore: Restore };
};

/** ASCII JS identifiers: fold names become `ctx.folds` properties (`folds.conversation()`). */
const FOLD_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FOLD_SCOPES: ReadonlyArray<FoldScope> = ['context', 'run'];

function fail(name: string, detail: string): never {
  throw new ContextFoldDefinitionError(name, `ContextFold ${JSON.stringify(name)}: ${detail}`);
}

const NAME_RULE =
  'the name must be a JS identifier (letters, digits, `_` and `$`, not starting with a ' +
  'digit): it is the accessor name in `ctx.folds`.';

function isFoldName(name: string): boolean {
  // `__proto__` is an identifier, but as a dynamic key it sets the prototype instead.
  return FOLD_NAME_PATTERN.test(name) && name !== '__proto__';
}

function assertFoldName(name: string): void {
  if (!isFoldName(name)) fail(name, NAME_RULE);
}

function assertScope(name: string, scope: string): void {
  if (!FOLD_SCOPES.includes(scope as FoldScope)) {
    fail(name, `unknown scope ${JSON.stringify(scope)}; use 'context' or 'run'.`);
  }
}

/** Runtime of `ContextFoldBuilder` / `ContextFoldEventsBuilder` (immutable: each step copies). */
class ContextFoldBuilderImpl {
  constructor(private readonly definition: Definition) {}

  get name(): string {
    return this.definition.name;
  }

  scope(scope: FoldScope): ContextFoldBuilderImpl {
    assertScope(this.definition.name, scope);
    return new ContextFoldBuilderImpl({ ...this.definition, scope });
  }

  over(events: ReadonlyArray<EventDef>): ContextFoldBuilderImpl {
    const { name } = this.definition;
    if (events.length === 0) fail(name, 'over() needs at least one event.');
    const all = [...this.definition.events, ...events];
    const seen = new Set<string>();
    for (const event of all) {
      if (seen.has(event.name)) {
        fail(name, `event ${JSON.stringify(event.name)} is listed twice in over().`);
      }
      seen.add(event.name);
    }
    return new ContextFoldBuilderImpl({ ...this.definition, events: all });
  }

  initial(initial: () => unknown): ContextFoldImpl {
    if (this.definition.events.length === 0) {
      fail(this.definition.name, 'call over() with the folded events before initial().');
    }
    return new ContextFoldImpl({ ...this.definition, initial });
  }
}

/** Runtime of `ContextFold` (immutable: `on` / `checkpointOn` return a new fold). */
class ContextFoldImpl {
  readonly name: string;
  readonly version: number;
  readonly scope: FoldScope;
  readonly eventNames: ReadonlyArray<string>;
  readonly checkpointEventName: string | undefined;
  /** Completeness is checked once, on first use: the definition never changes. */
  private complete = false;

  constructor(private readonly definition: Definition) {
    this.name = definition.name;
    this.version = definition.version;
    this.scope = definition.scope;
    this.eventNames = definition.events.map((event) => event.name);
    this.checkpointEventName = definition.checkpoint?.eventName;
  }

  get fold(): ContextFoldImpl {
    return this;
  }

  select(state: unknown): unknown {
    return state;
  }

  initialState(): unknown {
    this.assertComplete();
    return (this.definition.initial as () => unknown)();
  }

  apply(state: unknown, event: EnvelopeLike): unknown {
    this.assertComplete();
    const { checkpoint } = this.definition;
    if (event.name === checkpoint?.eventName) return checkpoint.restore(event);
    const handler = this.definition.handlers.get(event.name);
    return handler ? handler(state, event) : state;
  }

  applyAll(state: unknown, events: Iterable<EnvelopeLike>): unknown {
    this.assertComplete();
    let next = state;
    for (const event of events) next = this.apply(next, event);
    return next;
  }

  on(event: EventDef, handler: Handler): ContextFoldImpl {
    this.assertUnhandled(event, '.on()');
    const handlers = new Map(this.definition.handlers);
    handlers.set(event.name, handler);
    return new ContextFoldImpl({ ...this.definition, handlers });
  }

  checkpointOn(event: EventDef, restore: Restore): ContextFoldImpl {
    const { checkpoint } = this.definition;
    if (checkpoint) {
      fail(
        this.name,
        `a fold has one checkpoint event; ${JSON.stringify(checkpoint.eventName)} already is.`,
      );
    }
    this.assertUnhandled(event, '.checkpointOn()');
    return new ContextFoldImpl({
      ...this.definition,
      checkpoint: { eventName: event.name, restore },
    });
  }

  view(name: string, options: RuntimeViewOptions): ContextView<string, unknown> {
    this.assertComplete();
    const failView = (detail: string): never => {
      throw new ContextFoldDefinitionError(
        this.name,
        `ContextView ${JSON.stringify(name)} of fold ${JSON.stringify(this.name)}: ${detail}`,
      );
    };
    if (!isFoldName(name)) failView(NAME_RULE);
    const { budget, strategies = [] } = options;
    if (budget !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(budget) && budget > 0)) {
      failView(
        'the budget must be a positive integer (tokens) or Infinity (no budget); ' +
          `got ${budget}.`,
      );
    }
    if (strategies.some((strategy) => typeof strategy !== 'function')) {
      failView('strategies must be functions (state, { budget, tokens, count }) => state.');
    }
    if (options.measure === undefined && !isSegmentedState(this.initialState())) {
      failView(
        'the fold state has no segments; pass measure(state) to count its tokens, or build ' +
          'the fold with SegmentedFold.',
      );
    }
    return createView(this as unknown as AnyContextFold, name, options);
  }

  /** Every `over()` event has a handler or is the checkpoint event (checked once). */
  assertComplete(): void {
    if (this.complete) return;
    const missing = this.eventNames.filter(
      (name) => !this.definition.handlers.has(name) && name !== this.checkpointEventName,
    );
    if (missing.length > 0) {
      fail(
        this.name,
        `no handler for ${missing.map((name) => JSON.stringify(name)).join(', ')}; add an ` +
          '.on() handler for each (or make one the .checkpointOn() event).',
      );
    }
    this.complete = true;
  }

  /** `event` is one of `over()` and has neither a handler nor is the checkpoint event yet. */
  private assertUnhandled(event: EventDef, method: string): void {
    const eventName = JSON.stringify(event.name);
    if (!this.eventNames.includes(event.name)) {
      fail(this.name, `${method} for ${eventName}, which is not one of the over() events.`);
    }
    if (this.definition.handlers.has(event.name)) {
      fail(this.name, `${method} for ${eventName}, which already has an .on() handler.`);
    }
    if (event.name === this.checkpointEventName) {
      fail(this.name, `${method} for ${eventName}, which is already the checkpoint event.`);
    }
  }
}

/**
 * Defines a context fold.
 *
 * ```ts
 * const Conversation = ContextFold.of('conversation', { version: 1 })
 *   .over([UserPrompt, AssistantMessage, ContextCompacted])
 *   .initial((): Conversation => ({ turns: [] }))
 *   .on(UserPrompt, (state, { payload }) => ({ turns: [...state.turns, user(payload.text)] }))
 *   .on(AssistantMessage, (state, { payload }) => ({ turns: [...state.turns, model(payload)] }))
 *   .checkpointOn(ContextCompacted, ({ payload }) => ({ turns: [summary(payload.summary)] }));
 * ```
 *
 * Validation happens as early as possible: the name, version, scope, `over()` events and each
 * handler are checked when the builder method is called. Completeness (every `over()` event
 * handled) can only be checked once the definition is finished: by `ContextFold.validate(source)`
 * (the runtime calls it when sources are registered) and, at the latest, on the fold's first
 * `initialState()` / `apply()` / `applyAll()`.
 */
export const ContextFold: {
  /**
   * Starts a fold named `name` (a JS identifier: the accessor in `ctx.folds`). A literal name
   * that is not one is a type error (`ValidFoldName`) as well as a runtime error.
   */
  of<const Name extends string>(
    name: Name & ValidFoldName<Name>,
    options: ContextFoldOptions,
  ): ContextFoldBuilder<Name>;
  validate(source: unknown): asserts source is FoldSource;
} = {
  of<const Name extends string>(
    name: Name & ValidFoldName<Name>,
    options: ContextFoldOptions,
  ): ContextFoldBuilder<Name> {
    assertFoldName(name);
    const { version } = options;
    if (!Number.isSafeInteger(version) || version < 1) {
      fail(name, `version must be a positive integer; got ${version}.`);
    }
    return new ContextFoldBuilderImpl({
      name,
      version,
      scope: 'context',
      events: [],
      handlers: new Map(),
    }) as unknown as ContextFoldBuilder<Name>;
  },

  /**
   * Throws `ContextFoldDefinitionError` unless `source` is a usable `FoldSource`: a complete fold
   * (every `over()` event handled, `initial()` given) or a source wrapping one, whose name is a
   * JS identifier and that has a `select` function. Covers what the types cannot (JavaScript
   * callers, casts); the runtime calls it for every source given to `.folds()`.
   */
  validate(source: unknown): asserts source is FoldSource {
    if (source instanceof ContextFoldBuilderImpl) {
      fail(source.name, 'missing initial(): call .initial(() => state) after over().');
    }
    const candidate = source as Partial<FoldSource> | undefined;
    if (!(candidate?.fold instanceof ContextFoldImpl)) {
      const name = String(candidate?.name);
      throw new ContextFoldDefinitionError(
        name,
        `${JSON.stringify(name)} is not a fold source: pass a ContextFold or a view of one.`,
      );
    }
    assertFoldName(String(candidate.name));
    if (typeof candidate.select !== 'function') {
      fail(String(candidate.name), 'a fold source needs a select(state) function.');
    }
    candidate.fold.assertComplete();
  },
};
