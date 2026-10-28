import { Either, type ParseResult, Schema as S } from 'effect';
import type { EventEnvelope } from '../agent-factory.js';
import type { AgentNetworkEventDef, EnvelopeLike } from '../agent-network/agent-network-event.js';
import { decodeStoredPayload } from '../agent-network/stored-payload.js';
import { type FoldCheckpointEventName, foldCheckpointEventName } from './fold-checkpoint.js';

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

/** Options of `ContextFold.of(name, options?)`. */
export type ContextFoldOptions<
  Scope extends FoldScope = FoldScope,
  StateSchema extends S.Schema.AnyNoContext = S.Schema.AnyNoContext,
> = {
  /**
   * Which events the fold reads: every run of the context (`'context'`, the default) or the
   * current run only (`'run'`).
   */
  readonly scope?: Scope;
  /**
   * Positive integer, default 1: the version of the state's shape. A fold only restores
   * checkpoints of its own name and version (`m4trix:fold.checkpoint:<name>@<version>`), so bump
   * it when the state (or its schema) changes in a way old checkpoints do not fit: the fold then
   * starts from scratch, or from a checkpoint written by the new version. It is not part of the
   * cache identity: the runtime caches state per fold object.
   */
  readonly version?: number;
  /**
   * An Effect schema of the state. When given, the fold's state type is the schema's type and
   * `initial()` must return one, so `initial(() => ({ turns: [] }))` needs no annotation. A
   * context-scoped fold with one can compact (`folds.<name>.compact(...)`): its checkpoints store
   * the state encoded with this schema.
   */
  readonly state?: StateSchema;
};

/**
 * A fold definition is invalid: a name that is not a JS identifier, a version that is not a
 * positive integer, an unknown scope, a `state` (or a segmented fold's `data`, `summary` or
 * `tag`) that is not a schema (a string), a second handler for an event, a handler that is not a
 * function, a missing
 * `initial()`, a fold that reads no events, something that is not a fold (e.g. a view) passed to
 * `.folds([...])`, or invalid `ContextView.of` options. See `ContextFold.validate` for when each
 * is reported.
 */
export class ContextFoldDefinitionError extends Error {
  /** Discriminant for `catch` / Effect error handling. */
  readonly _tag = 'ContextFoldDefinitionError' as const;
  /**
   * Name of the fold whose definition is invalid (for a view: its fold; for something passed
   * where a fold belongs: its `name`, if any).
   */
  readonly foldName: string;

  constructor(foldName: string, message: string) {
    super(message);
    this.name = 'ContextFoldDefinitionError';
    this.foldName = foldName;
  }
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
  readonly 'a fold name must be a JS identifier': Name;
}

/**
 * `unknown` for a valid fold name, else `InvalidFoldName<Name>`. Intersected with a name
 * parameter (`name: Name & ValidFoldName<Name>`), it turns a literal name that is not a JS
 * identifier into a type error at the call.
 */
export type ValidFoldName<Name extends string> =
  IsFoldName<Name> extends true ? unknown : InvalidFoldName<Name>;

/**
 * Type-level marker of an event that already has a handler: intersected with the event parameter
 * of `.on()` (and a segmented fold's `.open()` / `.attach()`), it makes a second handler a type
 * error at the call.
 */
export interface DuplicateFoldHandler<EventName extends string> {
  /** The event that is already handled, shown in the type error. */
  readonly 'a fold handles each event once; already handled': EventName;
}

/**
 * `unknown` while the event `E` has no handler among `Handled`, else `DuplicateFoldHandler`:
 * intersected with the event parameter of a handler method (`.on()`, `.open()`, `.attach()`).
 */
export type UnhandledFoldEvent<
  E extends AgentNetworkEventDef<string, S.Schema.Any>,
  Handled extends string,
> = [E['name']] extends [Handled] ? DuplicateFoldHandler<E['name']> : unknown;

/**
 * A fold of any state, as the runtime sees it: what `.folds([...])` takes. The fold object itself
 * identifies its cached state: agents given the same object share it.
 */
export interface AnyContextFold {
  /** Fold name, also its accessor in `ctx.folds` (a JS identifier). */
  readonly name: string;
  /** See `ContextFoldOptions.version` (default 1). */
  readonly version: number;
  /** Which events the fold reads: the whole context or the current run. */
  readonly scope: FoldScope;
  /** Names of the events the fold's handlers handle. */
  readonly eventNames: ReadonlyArray<string>;
  /**
   * The name of the fold's checkpoints (`m4trix:fold.checkpoint:<name>@<version>`), published by
   * the runtime when the fold is compacted; `undefined` for a fold that cannot compact (one
   * without a `state` schema, or a run-scoped one). A read restores the newest one.
   */
  readonly checkpointEventName: string | undefined;
  /**
   * The schema of the state (`ContextFoldOptions.state`; a segmented fold's is derived from its
   * `data` and `summary` schemas), if any.
   */
  readonly stateSchema: S.Schema.AnyNoContext | undefined;
  /** A fresh initial state (`initial()`). */
  initialState(): unknown;
  /** Folds one envelope with a decoded payload (see `ContextFold#apply`). */
  apply(state: unknown, event: EnvelopeLike): unknown;
  /** Folds `events` in order (oldest first), starting from `state`. */
  applyAll(state: unknown, events: Iterable<EnvelopeLike>): unknown;
}

/** State type of a fold (what `initial()` and its handlers return). */
export type FoldStateOf<F> = F extends { initialState(): infer State } ? State : never;

/**
 * `T`, read-only all the way down, for plain data: objects get `readonly` properties, arrays and
 * tuples become read-only, `Map` / `Set` become `ReadonlyMap` / `ReadonlySet`. Left as they are:
 * primitives, functions, `unknown`, `any`, and built-in instances (`Date`, `RegExp`, `Error`,
 * `Promise`, `WeakMap`, `WeakSet`, `ArrayBuffer` and typed arrays; types are structural, so an
 * object with exactly the shape of an `Error` counts as one). Other class instances are mapped
 * like objects, so a class with `private` members no longer matches its own type: keep such a
 * fold's state plain data, or give the fold a `state` schema (see `FoldReadStateOf`).
 */
export type DeepReadonly<T> = unknown extends T
  ? T
  : // Map and Set first: structurally, a Set is also a WeakSet (a leaf below).
    T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends
            | string
            | number
            | boolean
            | bigint
            | symbol
            | null
            | undefined
            | ((...args: never) => unknown)
            | Date
            | RegExp
            | Error
            | Promise<unknown>
            | WeakMap<object, unknown>
            | WeakSet<object>
            | ArrayBuffer
            | ArrayBufferView
        ? T
        : { readonly [K in keyof T]: DeepReadonly<T[K]> };

/**
 * What reading the fold `F` resolves to (`ctx.folds`), and what its views take: its state,
 * read-only. A read may hand out the cached state itself, shared by every reader, so it must
 * never be written to, and at runtime it cannot be: every read freezes the plain objects and
 * arrays of the state (`Object.freeze`, all the way down), so a write throws a `TypeError` in
 * strict mode. `Date`s, `Map`s, `Set`s, `Option`s and class instances are not frozen (Effect
 * caches hashes on its data types). A fold with a `state` schema (and every `SegmentedFold`) reads
 * as the schema's type, as it is: Effect schema types are read-only already (unless made
 * `S.mutable`), and their `Date`s, `Option`s and classes stay what they are. A fold without one
 * reads as `DeepReadonly<State>`. Type helpers that take a read state with it, e.g.
 * `(log: FoldReadStateOf<typeof Log>) => …`.
 */
export type FoldReadStateOf<F> = F extends { readonly stateSchema: S.Schema.AnyNoContext }
  ? FoldStateOf<F>
  : DeepReadonly<FoldStateOf<F>>;

/**
 * `ContextFold.of(name, options?)`: `initial()` makes it a fold. `StateSchema` is the `state`
 * schema as `S.Schema<State, Encoded>`, `undefined` without one.
 */
export interface ContextFoldBuilder<
  Name extends string,
  Scope extends FoldScope = 'context',
  StateSchema extends S.Schema.AnyNoContext | undefined = undefined,
> {
  /**
   * The state before any event, created on every cold start (so return a fresh value). With a
   * `state` schema, the fold's state type is the schema's and `initial` must return one. Without
   * one, it is `initial`'s return type: annotate it when inference would be too narrow, e.g.
   * `.initial((): Conversation => ({ turns: [] }))` (`[]` alone infers `never[]`), or pass a
   * `state` schema.
   */
  initial<
    T extends [StateSchema] extends [S.Schema.AnyNoContext] ? S.Schema.Type<StateSchema> : unknown,
  >(
    initial: () => T,
  ): ContextFold<
    Name,
    Scope,
    [StateSchema] extends [S.Schema.AnyNoContext] ? S.Schema.Type<StateSchema> : T,
    never,
    StateSchema
  >;
}

/**
 * What every fold has, whichever builder made it (`ContextFold`, `SegmentedFold`): its identity,
 * the events it reads and the pure functions that fold them into `State`. The builders' own
 * interfaces add their handler methods and `stateSchema`.
 */
export interface ContextFoldBase<
  Name extends string,
  Scope extends FoldScope,
  State,
  Handled extends string = never,
> {
  /** Fold name, also its accessor in `ctx.folds` (a JS identifier). */
  readonly name: Name;
  /** See `ContextFoldOptions.version` (default 1). */
  readonly version: number;
  /** Which events the fold reads: the whole context (`'context'`) or the current run (`'run'`). */
  readonly scope: Scope;
  /** Names of the events the fold's handlers handle, in the order added. */
  readonly eventNames: ReadonlyArray<Handled>;
  /** See `AnyContextFold.checkpointEventName`. */
  readonly checkpointEventName: string | undefined;
  /** A fresh initial state (`initial()`). */
  initialState(): State;
  /**
   * Folds one envelope whose payload is decoded (a value of its event's schema type, e.g. from
   * `Event.makeBound(meta, payload)`): a handled event runs its handler, any other event (a
   * checkpoint included: the reader restores those) returns `state` unchanged. Stored events hold
   * encoded payloads: `ctx.folds` decodes them with the handler's event schema before folding
   * (leaving out, and reporting, what no longer decodes); `apply` decodes nothing.
   */
  apply(state: State, event: EnvelopeLike): State;
  /** Folds `events` in order (oldest first), starting from `state`. */
  applyAll(state: State, events: Iterable<EnvelopeLike>): State;
}

/**
 * A fold of events into `State`. Its `.on()` handlers define the events it reads: `Handled` tracks
 * them at type level, so a second handler for an event is a type error. A fold needs at least one event: one without is rejected at runtime by
 * `ContextFold.validate` (which `.folds([...])` runs) and on first use. `StateSchema` is the
 * `state` schema given to `ContextFold.of()`, as `S.Schema<State, Encoded>`, or `undefined`.
 *
 * Handlers are **pure** `(state, envelope) => state`: no I/O, no mutation of `state` (return a new
 * value), no clock or randomness. The same events must always fold to the same state; the runtime
 * caches folded state and folds only newer events into it, so it relies on that.
 *
 * Every step returns a new fold and leaves the previous one as it was.
 */
export interface ContextFold<
  Name extends string,
  Scope extends FoldScope,
  State,
  Handled extends string = never,
  StateSchema extends S.Schema.AnyNoContext | undefined = undefined,
> extends ContextFoldBase<Name, Scope, State, Handled> {
  /**
   * The `state` schema given to `ContextFold.of()`, typed with the state and its encoded type;
   * `undefined` without one (see `ContextFoldOptions.state`).
   */
  readonly stateSchema: StateSchema;
  /**
   * `m4trix:fold.checkpoint:<name>@<version>` when the fold can compact (a `state` schema and
   * context scope), else `undefined`.
   */
  readonly checkpointEventName: [StateSchema, Scope] extends [S.Schema.AnyNoContext, 'context']
    ? FoldCheckpointEventName<Name>
    : undefined;
  /**
   * Handles `event` (one without a handler yet): `handler` gets the current state and the typed
   * envelope and returns the next state, without mutating the current one.
   */
  on<E extends AgentNetworkEventDef<string, S.Schema.Any>>(
    event: E & UnhandledFoldEvent<E, Handled>,
    handler: (state: State, envelope: EventEnvelope<E>) => State,
  ): ContextFold<Name, Scope, State, Handled | E['name'], StateSchema>;
}

/**
 * @internal An event a read left out of a fold (`FoldReaderOptions.onSkip`): a stored event whose
 * payload does not decode with its event's schema (`'decode'`), a checkpoint that cannot be
 * restored (`'checkpoint'`), or an event `attach` found no segment for (`'missing-segment'`, with
 * `onMissing: 'report'`). The fold's state is as if the event was not there.
 */
export type FoldSkip =
  | {
      readonly fold: string;
      readonly reason: 'decode' | 'checkpoint';
      readonly event: EnvelopeLike;
      /** Why it does not decode. */
      readonly error: ParseResult.ParseError;
    }
  | {
      readonly fold: string;
      readonly reason: 'missing-segment';
      readonly event: EnvelopeLike;
      /** The segment the event belongs to, which the state does not have. */
      readonly segment: { readonly id: string; readonly kind?: string };
    };

/** @internal Called by a handler (`attach`) for an event whose segment is missing. */
export type MissingSegmentReport = (
  event: EnvelopeLike,
  segment: { readonly id: string; readonly kind?: string },
) => void;

/** A handler; the reader passes `report` when it reports missing segments (see `FoldSkip`). */
type Handler = (state: unknown, envelope: EnvelopeLike, report?: MissingSegmentReport) => unknown;

/** @internal What a fold is made of. Folds are immutable: each builder step copies it. */
export type FoldDefinition = {
  readonly name: string;
  readonly version: number;
  readonly scope: FoldScope;
  readonly stateSchema: S.Schema.AnyNoContext | undefined;
  readonly initial: () => unknown;
  /** Every event the fold handles, in the order added. */
  readonly eventNames: ReadonlyArray<string>;
  /**
   * Handlers by event name, with the event definition (its schema decodes the stored payload)
   * and the method that added them (for error messages).
   */
  readonly handlers: ReadonlyMap<
    string,
    { readonly method: string; readonly event: EventDef; readonly handler: Handler }
  >;
};

/** ASCII JS identifiers: fold names become `ctx.folds` properties (`folds.conversation()`). */
const FOLD_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FOLD_SCOPES: ReadonlyArray<unknown> = ['context', 'run'];

const NAME_RULE =
  'the name must be a JS identifier (letters, digits, `_` and `$`, not starting with a ' +
  'digit): it is the accessor name in `ctx.folds`.';

function isFoldName(name: string): boolean {
  // `__proto__` is an identifier, but as a dynamic key it sets the prototype instead.
  return FOLD_NAME_PATTERN.test(name) && name !== '__proto__';
}

/** @internal `${label} "name": detail` (`label`: `ContextFold` or `SegmentedFold`). */
export function foldDefinitionError(
  label: string,
  name: string,
  detail: string,
): ContextFoldDefinitionError {
  return new ContextFoldDefinitionError(name, `${label} ${JSON.stringify(name)}: ${detail}`);
}

/** @internal Validates the name, `version` and `scope` of a fold and fills in the defaults. */
export function resolveFoldOptions(
  label: string,
  name: string,
  options: { readonly scope?: unknown; readonly version?: unknown } | undefined,
): { readonly version: number; readonly scope: FoldScope } {
  if (!isFoldName(name)) throw foldDefinitionError(label, name, NAME_RULE);
  const version = options?.version ?? 1;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw foldDefinitionError(label, name, `version must be a positive integer; got ${version}.`);
  }
  const scope = options?.scope ?? 'context';
  if (!FOLD_SCOPES.includes(scope)) {
    throw foldDefinitionError(
      label,
      name,
      `unknown scope ${JSON.stringify(scope)}; use 'context' or 'run'.`,
    );
  }
  return { version: version as number, scope: scope as FoldScope };
}

/** @internal An event definition (for JavaScript callers and casts): an object with a name. */
export function isEventDefinition(event: unknown): event is EventDef {
  return typeof (event as Partial<EventDef> | null)?.name === 'string';
}

type BuilderDefinition = Pick<FoldDefinition, 'name' | 'version' | 'scope' | 'stateSchema'>;

/** Runtime of `ContextFoldBuilder`. */
class ContextFoldBuilderImpl {
  constructor(private readonly definition: BuilderDefinition) {}

  get name(): string {
    return this.definition.name;
  }

  initial(initial: () => unknown): ContextFoldImpl {
    if (typeof initial !== 'function') {
      throw foldDefinitionError(
        'ContextFold',
        this.name,
        '.initial() needs a function () => state.',
      );
    }
    return new ContextFoldImpl({
      ...this.definition,
      initial,
      eventNames: [],
      handlers: new Map(),
    });
  }
}

/**
 * @internal Runtime of `ContextFold` (immutable: `on` returns a new fold of the same class, see
 * `with`). `SegmentedFoldImpl` extends it.
 */
export class ContextFoldImpl {
  readonly name: string;
  readonly version: number;
  readonly scope: FoldScope;
  readonly eventNames: ReadonlyArray<string>;
  readonly checkpointEventName: string | undefined;
  readonly stateSchema: S.Schema.AnyNoContext | undefined;

  constructor(protected readonly definition: FoldDefinition) {
    this.name = definition.name;
    this.version = definition.version;
    this.scope = definition.scope;
    this.eventNames = definition.eventNames;
    // Only a fold whose state can be stored (a schema) and that spans the context can compact.
    this.checkpointEventName =
      definition.stateSchema !== undefined && definition.scope === 'context'
        ? foldCheckpointEventName(definition)
        : undefined;
    this.stateSchema = definition.stateSchema;
  }

  /** The builder named in error messages. */
  protected get label(): string {
    return 'ContextFold';
  }

  /** The methods that add handlers, named in the error of a fold without events. */
  protected get handlerMethods(): string {
    return '.on()';
  }

  /** A fold of this class with `definition`. */
  protected with(definition: FoldDefinition): this {
    return new ContextFoldImpl(definition) as this;
  }

  protected fail(detail: string): never {
    throw foldDefinitionError(this.label, this.name, detail);
  }

  initialState(): unknown {
    this.assertEvents();
    return this.definition.initial();
  }

  apply(state: unknown, event: EnvelopeLike): unknown {
    this.assertEvents();
    return this.step(state, event);
  }

  applyAll(state: unknown, events: Iterable<EnvelopeLike>): unknown {
    this.assertEvents();
    let next = state;
    for (const event of events) next = this.step(next, event);
    return next;
  }

  /** Folds one event (the fold was checked by the caller). */
  private step(state: unknown, event: EnvelopeLike): unknown {
    const handled = this.definition.handlers.get(event.name);
    return handled ? handled.handler(state, event) : state;
  }

  /**
   * Folds stored events (see `foldStoredEvents`): each handled event's payload is decoded with
   * its event's schema first; one that does not decode is left out and reported to `onSkip`, as
   * are events `attach` finds no segment for (`onMissing: 'report'`).
   */
  foldStored(
    state: unknown,
    events: Iterable<EnvelopeLike>,
    onSkip: ((skip: FoldSkip) => void) | undefined,
  ): unknown {
    this.assertEvents();
    const { name } = this;
    const report: MissingSegmentReport | undefined =
      onSkip &&
      ((event, segment) => onSkip({ fold: name, reason: 'missing-segment', event, segment }));
    let next = state;
    for (const event of events) {
      const handled = this.definition.handlers.get(event.name);
      if (!handled) continue;
      const decoded = decodeStoredPayload(handled.event.payload, event.payload);
      if (Either.isLeft(decoded)) {
        onSkip?.({ fold: name, reason: 'decode', event, error: decoded.left });
        continue;
      }
      // A payload that needed no decoding is the stored one itself (frozen): the event as it is.
      const envelope =
        decoded.right === event.payload
          ? event
          : { name: event.name, meta: event.meta, payload: decoded.right };
      next = handled.handler(next, envelope, report);
    }
    return next;
  }

  /** The definitions of the events the fold handles, in the order added. */
  handledEvents(): ReadonlyArray<EventDef> {
    return [...this.definition.handlers.values()].map((handled) => handled.event);
  }

  on(event: EventDef, handler: Handler): this {
    return this.handle('.on()', event, handler);
  }

  /** The fold handles at least one event. */
  assertEvents(): void {
    if (this.eventNames.length > 0) return;
    this.fail(`it folds no events; add a handler (${this.handlerMethods}).`);
  }

  /** Adds `handler` for `event`, which has none yet (`method` names the caller in errors). */
  protected handle(method: string, event: EventDef, handler: Handler): this {
    this.assertHandlerArguments(method, event, handler);
    this.assertUnhandled(method, event.name);
    const handlers = new Map(this.definition.handlers);
    handlers.set(event.name, { method, event, handler });
    return this.with({
      ...this.definition,
      eventNames: [...this.eventNames, event.name],
      handlers,
    });
  }

  /** `event` is an event definition and `fn` a function (for JavaScript callers and casts). */
  protected assertHandlerArguments(method: string, event: unknown, fn: unknown): void {
    if (isEventDefinition(event) && typeof fn === 'function') return;
    this.fail(`${method} needs an event definition (AgentNetworkEvent.of(...)) and a function.`);
  }

  /** `eventName` has no handler yet. */
  private assertUnhandled(method: string, eventName: string): void {
    const existing = this.definition.handlers.get(eventName);
    if (existing) {
      this.fail(
        `${method} for ${JSON.stringify(eventName)}, which already has a handler ` +
          `(${existing.method}); a fold handles each event once.`,
      );
    }
  }
}

/**
 * Defines a context fold.
 *
 * ```ts
 * const Conversation = ContextFold.of('conversation', { state: ConversationSchema })
 *   .initial(() => ({ turns: [] }))
 *   .on(UserPrompt, (state, { payload }) => ({ turns: [...state.turns, user(payload.text)] }))
 *   .on(AssistantMessage, (state, { payload }) => ({ turns: [...state.turns, model(payload)] }));
 * ```
 *
 * The handlers define the events the fold reads. Validation happens as early
 * as possible: the name, options and each handler are checked when the builder method is called;
 * a second handler for an event is also a type error. That the fold reads at least one event can
 * only be checked once it is finished: by `ContextFold.validate(source)` (the runtime calls it when
 * an agent or aggregator declares its `.folds([...])`) and, at the latest, on the fold's first
 * `initialState()` / `apply()` / `applyAll()` or `ContextView.of()`.
 *
 * The runtime caches a fold's state per fold object, and its checkpoints are stored by name and
 * version. Give each fold in a network its own name (the wiring check fails setup for different
 * compactable folds of one name and version, which would share checkpoints, and warns for other
 * name sharing), define it once (e.g. exported from a module) and give every agent that reads it
 * that object: they then share its state.
 */
export const ContextFold: {
  /**
   * Starts a fold named `name` (a JS identifier: the accessor in `ctx.folds`). A literal name
   * that is not one is a type error (`ValidFoldName`) as well as a runtime error. Give each fold
   * in a network its own name (see the wiring codes `fold-checkpoint-shared` and
   * `fold-name-shared`).
   * `options`: `scope` (default `'context'`), `version` (default 1) and an optional `state`
   * schema, see `ContextFoldOptions`. The fold type records the schema as
   * `S.Schema<State, Encoded>` (`stateSchema`), or `undefined` without one.
   */
  of<
    const Name extends string,
    const Scope extends FoldScope = 'context',
    StateSchema extends S.Schema.AnyNoContext = never,
  >(
    name: Name & ValidFoldName<Name>,
    options?: ContextFoldOptions<Scope, StateSchema>,
  ): ContextFoldBuilder<
    Name,
    Scope,
    [StateSchema] extends [never]
      ? undefined
      : S.Schema<S.Schema.Type<StateSchema>, S.Schema.Encoded<StateSchema>>
  >;
  /**
   * Throws `ContextFoldDefinitionError` unless `source` is a usable fold: built by
   * `ContextFold.of(...).initial(...)` or `SegmentedFold.of(...)`, reading at least one event.
   * Covers what the types cannot (JavaScript callers, casts, a fold without handlers, a view
   * passed where a fold belongs); the runtime calls it for every fold given to `.folds()` and
   * `ContextView.of()`.
   */
  validate(source: unknown): asserts source is AnyContextFold;
} = {
  of<
    const Name extends string,
    const Scope extends FoldScope = 'context',
    StateSchema extends S.Schema.AnyNoContext = never,
  >(
    name: Name & ValidFoldName<Name>,
    options?: ContextFoldOptions<Scope, StateSchema>,
  ): ContextFoldBuilder<
    Name,
    Scope,
    [StateSchema] extends [never]
      ? undefined
      : S.Schema<S.Schema.Type<StateSchema>, S.Schema.Encoded<StateSchema>>
  > {
    const { version, scope } = resolveFoldOptions('ContextFold', name, options);
    const stateSchema = options?.state;
    if (stateSchema !== undefined && !S.isSchema(stateSchema)) {
      throw foldDefinitionError(
        'ContextFold',
        name,
        'the state option must be an Effect schema, e.g. S.Struct({ ... }).',
      );
    }
    return new ContextFoldBuilderImpl({
      name,
      version,
      scope,
      stateSchema,
    }) as unknown as ContextFoldBuilder<
      Name,
      Scope,
      [StateSchema] extends [never]
        ? undefined
        : S.Schema<S.Schema.Type<StateSchema>, S.Schema.Encoded<StateSchema>>
    >;
  },

  validate(source: unknown): asserts source is AnyContextFold {
    if (source instanceof ContextFoldBuilderImpl) {
      throw foldDefinitionError(
        'ContextFold',
        source.name,
        'missing initial(): call .initial(() => state) after ContextFold.of().',
      );
    }
    const viewed = (source as { readonly fold?: unknown } | undefined)?.fold;
    if (typeof source === 'function' && viewed instanceof ContextFoldImpl) {
      const { name } = viewed;
      throw new ContextFoldDefinitionError(
        name,
        `a view of fold ${JSON.stringify(name)} (ContextView.of) is not a fold: declare ` +
          `${JSON.stringify(name)} in .folds([...]), read it (await folds.${name}()) and call ` +
          'the view with the state and a budget.',
      );
    }
    if (!(source instanceof ContextFoldImpl)) {
      const name = String((source as { readonly name?: unknown } | undefined)?.name);
      throw new ContextFoldDefinitionError(
        name,
        `${JSON.stringify(name)} is not a fold: pass a ContextFold or a SegmentedFold.`,
      );
    }
    source.assertEvents();
  },
};

/**
 * @internal Folds stored events (as `history` returns them) into `state`: decoded with their
 * event's schema first, see `ContextFoldImpl#foldStored`. `fold` was validated (a fold built by
 * `ContextFold.of` or `SegmentedFold.of`).
 */
export function foldStoredEvents(
  fold: AnyContextFold,
  state: unknown,
  events: Iterable<EnvelopeLike>,
  onSkip?: (skip: FoldSkip) => void,
): unknown {
  return (fold as unknown as ContextFoldImpl).foldStored(state, events, onSkip);
}

/** @internal The definitions of the events `fold` handles, in the order added. */
export function foldEventDefinitions(fold: AnyContextFold): ReadonlyArray<EventDef> {
  return (fold as unknown as ContextFoldImpl).handledEvents();
}
