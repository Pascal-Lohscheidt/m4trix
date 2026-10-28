import { Schema as S } from 'effect';
import type { EventEnvelope } from '../agent-factory.js';
import type { AgentNetworkEventDef, EnvelopeLike } from '../agent-network/agent-network-event.js';
import type { FoldCheckpointEventName } from './fold-checkpoint.js';
import {
  type AnyContextFold,
  type ContextFoldBase,
  ContextFoldImpl,
  type FoldDefinition,
  type FoldScope,
  foldDefinitionError,
  isEventDefinition,
  resolveFoldOptions,
  type UnhandledFoldEvent,
  type ValidFoldName,
} from './context-fold.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/**
 * Segmented folds: the state is a list of **segments**, each an atomic unit of the conversation
 * (a user prompt, a model step together with all its tool results, a final answer), plus an
 * optional summary of what came before (what a compaction left behind). Views trim a segmented state
 * to a token budget segment by segment, so a model step is never separated from its results.
 */

/**
 * One atomic unit of a segmented state. `id` addresses it (`attach`'s `to`, a view's `dropped`);
 * `data` is what the fold opened and attached to it. Ids should be unique (a payload id such as a
 * step id, or one derived from the event, e.g. `prompt:${runId}`).
 */
export type Segment<T> = {
  readonly id: string;
  readonly data: T;
};

/**
 * State of a segmented fold: its segments, oldest first, and the summary of what came before them
 * (absent until a compaction writes one, and for folds without a summary type `S`).
 */
export type SegmentedState<T, S = never> = {
  readonly summary?: S;
  readonly segments: ReadonlyArray<Segment<T>>;
};

/** Any segmented state: the constraint of the segment helpers and segment strategies. */
export type AnySegmentedState = SegmentedState<unknown, unknown>;

/** The segment type of a segmented state. */
export type SegmentOf<State extends AnySegmentedState> = State['segments'][number];

/** The segment data type of a segmented state. */
export type SegmentDataOf<State extends AnySegmentedState> = SegmentOf<State>['data'];

/** The summary type of a segmented state (`never` for a fold without one). */
export type SummaryOf<State extends AnySegmentedState> = Exclude<State['summary'], undefined>;

type IsStringLiteral<T> = [T] extends [never]
  ? false
  : [T] extends [string]
    ? string extends T
      ? false
      : true
    : false;

/** Fields of `Data` that are not a string literal in some variant. */
type NonTagFields<Data> = Data extends unknown
  ? { [K in keyof Data]: IsStringLiteral<Data[K]> extends true ? never : K }[keyof Data]
  : never;

/**
 * The fields of the segment data `Data` that can be its `tag`: present in every variant, with a
 * string literal type (e.g. `'kind'` for `{ kind: 'user'; … } | { kind: 'step'; … }`).
 */
export type SegmentTagOf<Data> = Exclude<keyof Data, NonTagFields<Data>> & string;

/**
 * The kinds of the segment data `Data`: the values of its `Tag` field, what `attach`'s `kind`
 * accepts (`never` when `Tag` is not one of `SegmentTagOf<Data>`).
 */
export type SegmentKindOf<Data, Tag extends string> =
  Tag extends SegmentTagOf<Data> ? Data[Tag & keyof Data] : never;

/**
 * What `attach`'s `update` gets for `kind: Kind`: each variant of `Data` whose `Tag` field can be
 * `Kind`, with that field narrowed to `Kind` (a variant whose field is exactly `Kind` stays as it
 * is); all of `Data` for no kind (`never`).
 */
export type SegmentDataOfKind<Data, Tag extends string, Kind> = [Kind] extends [never]
  ? Data
  : Data extends unknown
    ? [Kind & Data[Tag & keyof Data]] extends [never]
      ? never
      : [Data[Tag & keyof Data]] extends [Kind]
        ? Data
        : { [K in keyof Data]: K extends Tag ? Kind & Data[K] : Data[K] }
    : never;

/** Type-level marker of a `tag` that is not one of `SegmentTagOf<Data>` (see `ValidSegmentTag`). */
export interface InvalidSegmentTag<Tag extends string> {
  /** The rejected tag, shown in the type error. */
  readonly 'the tag must be a field with a string literal type in every variant of the data': Tag;
}

/**
 * Type-level marker of `attach`'s `kind` on a fold whose `tag` (`Tag`, `'_tag'` by default) is not
 * a field that tells the variants of the data apart: set `tag` on `SegmentedFold.of()`.
 */
export interface KindNeedsSegmentTag<Tag extends string> {
  /** The fold's tag, shown in the type error. */
  readonly 'kind needs SegmentedFold.of(name, { tag }): a field with a string literal type in every variant of the data; the tag is': Tag;
}

/**
 * `unknown` when `Tag` is one of `SegmentTagOf<Data>`, else `InvalidSegmentTag<Tag>`: intersected
 * with the `tag` option, it makes a field that does not tell the variants apart a type error.
 */
export type ValidSegmentTag<Data, Tag extends string> =
  Tag extends SegmentTagOf<Data> ? unknown : InvalidSegmentTag<Tag>;

/** Options of `SegmentedFold.of(name, options)`: schemas of the state, scope and version. */
export type SegmentedFoldOptions<
  Data extends S.Schema.AnyNoContext = S.Schema.AnyNoContext,
  Summary extends S.Schema.AnyNoContext = S.Schema.AnyNoContext,
  Tag extends string = string,
  Scope extends FoldScope = FoldScope,
> = {
  /** Effect schema of a segment's data, typically a tagged union (one variant per kind). */
  readonly data: Data;
  /**
   * Effect schema of the summary of earlier segments that a compaction writes (e.g. `S.String`);
   * none when left out.
   */
  readonly summary?: Summary;
  /**
   * The field of the data that tells its variants apart, which `attach`'s `kind` narrows on:
   * `'_tag'` by default (Effect's `S.TaggedStruct` / `Data.TaggedEnum`), e.g. `'kind'` for
   * `{ kind: 'user'; … } | { kind: 'step'; … }`. A field without a string literal type in every
   * variant is a type error.
   */
  readonly tag?: Tag & ValidSegmentTag<S.Schema.Type<Data>, Tag>;
  /** Every run of the context (`'context'`, the default) or the current run (`'run'`). */
  readonly scope?: Scope;
  /** See `ContextFoldOptions.version` (default 1). */
  readonly version?: number;
};

/**
 * Options of `SegmentedFold#attach(event, options)`: which segment the event updates and how.
 * `Kind` is the `kind` given (`never` without one).
 */
export type SegmentAttachOptions<
  E extends AgentNetworkEventDef<string, S.Schema.Any>,
  Data,
  Tag extends string,
  Kind,
> = {
  /**
   * Only a segment of this kind (its `tag` field) is a target, and `update` gets and returns that
   * variant (see `SegmentDataOfKind`). A segment with the id but of another kind is skipped. Needs
   * a `tag` that tells the variants apart (`KindNeedsSegmentTag` otherwise).
   */
  readonly kind?: [SegmentKindOf<Data, Tag>] extends [never] ? KindNeedsSegmentTag<Tag> : Kind;
  /** The id of the segment the event belongs to, e.g. `({ payload }) => payload.stepId`. */
  readonly to: (envelope: EventEnvelope<E>) => string;
  /**
   * What happens when no segment has that id (and kind). Either way the state stays as it was:
   * `'report'` (the default) also reports the event, like an event that does not decode (the
   * network logger warns, and the `m4trix.fold.read.skipped` metric counts it, once per event, with
   * `reason: 'missing-segment'`): a missing target is most often a wrong `to` or `kind`.
   * `'ignore'` says it is expected, e.g. a late tool result of a step that a compaction
   * summarized away. There is no option to throw: the event stays in the history, so a fold
   * that throws on it could never be read past it again.
   */
  readonly onMissing?: 'report' | 'ignore';
  /** The new data of the target segment (pure); return `data` itself to change nothing. */
  readonly update: (
    data: SegmentDataOfKind<Data, Tag, Kind>,
    envelope: EventEnvelope<E>,
  ) => SegmentDataOfKind<Data, Tag, Kind>;
};

/**
 * A fold whose state is a `SegmentedState<Data, Summary>`, built from schemas
 * (`SegmentedFold.of`). Besides the `ContextFoldBase` members, events open segments (`open`) or
 * update one (`attach`); `on` handles an event with the whole state, as the escape hatch for
 * anything else (e.g. removing a segment). Each event has one handler, whichever method added it.
 * `Encoded` is the encoded type of the state (`stateSchema`).
 */
export interface SegmentedFold<
  Name extends string,
  Scope extends FoldScope,
  Data,
  Summary = never,
  Tag extends string = '_tag',
  Handled extends string = never,
  Encoded = SegmentedState<Data, Summary>,
> extends ContextFoldBase<Name, Scope, SegmentedState<Data, Summary>, Handled> {
  /**
   * The schema of the state, derived from the `data` and `summary` schemas:
   * `{ summary?: Summary; segments: { id: string; data: Data }[] }`, encoded as `Encoded`.
   */
  readonly stateSchema: S.Schema<SegmentedState<Data, Summary>, Encoded>;
  /**
   * `m4trix:fold.checkpoint:<name>@<version>`: every segmented fold has a state schema, so a
   * context-scoped one can compact; `undefined` for a run-scoped one.
   */
  readonly checkpointEventName: [Scope] extends ['context']
    ? FoldCheckpointEventName<Name>
    : undefined;
  /**
   * The field of the segment data that tells its kinds apart (`SegmentedFoldOptions.tag`, `'_tag'`
   * by default): what `attach`'s `kind` and `ContextStrategy.fromNewest` compare.
   */
  readonly tag: Tag;
  /**
   * Each `event` opens a segment: `segment(envelope)` returns its `{ id, data }`, appended as the
   * newest segment. A repeated id opens another segment; `attach` targets the newest.
   */
  open<E extends AgentNetworkEventDef<string, S.Schema.Any>>(
    event: E & UnhandledFoldEvent<E, Handled>,
    segment: (envelope: EventEnvelope<E>) => Segment<Data>,
  ): SegmentedFold<Name, Scope, Data, Summary, Tag, Handled | E['name'], Encoded>;
  /**
   * Each `event` updates the newest segment with the id `to(envelope)` (and of `kind`, when
   * given): its data becomes `update(data, envelope)`, in place (the segment keeps its position).
   * Without such a segment the state stays as it was, and `onMissing` decides whether the read
   * reports the event (`'report'`, the default) or not (`'ignore'`). With `kind`, `update` gets
   * and must return that variant of the data (see `SegmentedFoldOptions.tag`).
   *
   * ```ts
   * .attach(ToolResult, {
   *   kind: 'step',
   *   to: ({ payload }) => payload.stepId,
   *   onMissing: 'ignore', // a late result of a summarized step is expected
   *   update: (step, { payload }) => ({ ...step, results: [...step.results, payload] }),
   * })
   * ```
   */
  attach<
    E extends AgentNetworkEventDef<string, S.Schema.Any>,
    const Kind extends SegmentKindOf<Data, Tag> = never,
  >(
    event: E & UnhandledFoldEvent<E, Handled>,
    options: SegmentAttachOptions<E, Data, Tag, Kind>,
  ): SegmentedFold<Name, Scope, Data, Summary, Tag, Handled | E['name'], Encoded>;
  /**
   * Handles `event` with the whole state (see `ContextFold#on`): for what `open` and `attach`
   * cannot express, e.g. removing or merging segments.
   */
  on<E extends AgentNetworkEventDef<string, S.Schema.Any>>(
    event: E & UnhandledFoldEvent<E, Handled>,
    handler: (
      state: SegmentedState<Data, Summary>,
      envelope: EventEnvelope<E>,
    ) => SegmentedState<Data, Summary>,
  ): SegmentedFold<Name, Scope, Data, Summary, Tag, Handled | E['name'], Encoded>;
}

/**
 * Any segmented fold (`SegmentedFold.of`) with segment data `Data`, tag `Tag` and summary
 * `Summary`, as `ContextView.of` and `ContextStrategy.fromNewest` take it. A `ContextFold` is
 * not one, even with a state of segments: views count it as a whole.
 */
export interface AnySegmentedFold<Data = unknown, Tag extends string = string, Summary = unknown>
  extends AnyContextFold {
  /** See `SegmentedFold#tag`. */
  readonly tag: Tag;
  /** A fresh initial state: no segments. */
  initialState(): SegmentedState<Data, Summary>;
}

/** `attach` options as the runtime sees them (validated by `SegmentedFoldImpl#attach`). */
type RuntimeAttachOptions = {
  readonly kind?: string;
  readonly to: (envelope: EnvelopeLike) => string;
  readonly onMissing?: string;
  readonly update: (data: unknown, envelope: EnvelopeLike) => unknown;
};

const DEFAULT_TAG = '_tag';

const emptySegmentedState = (): AnySegmentedState => ({ segments: [] });

/**
 * @internal Runtime of `SegmentedFold`: a `ContextFoldImpl` whose `open` / `attach` add handlers
 * over its segments.
 */
class SegmentedFoldImpl extends ContextFoldImpl {
  constructor(
    definition: FoldDefinition,
    /** The data field `attach`'s `kind` compares. */
    readonly tag: string,
  ) {
    super(definition);
  }

  protected override get label(): string {
    return 'SegmentedFold';
  }

  protected override get handlerMethods(): string {
    return '.open(), .attach() or .on()';
  }

  protected override with(definition: FoldDefinition): this {
    return new SegmentedFoldImpl(definition, this.tag) as this;
  }

  open(event: EventDef, segment: (envelope: EnvelopeLike) => Segment<unknown>): this {
    this.assertHandlerArguments('.open()', event, segment);
    return this.handle('.open()', event, (state, envelope) => {
      const { id, data } = segment(envelope);
      const current = state as AnySegmentedState;
      return { ...current, segments: [...current.segments, { id, data }] };
    });
  }

  attach(event: EventDef, options: RuntimeAttachOptions): this {
    const { kind, to, onMissing, update } = options ?? ({} as Partial<RuntimeAttachOptions>);
    if (
      !isEventDefinition(event) ||
      typeof to !== 'function' ||
      typeof update !== 'function' ||
      (kind !== undefined && typeof kind !== 'string')
    ) {
      this.fail(
        '.attach() needs an event definition (AgentNetworkEvent.of(...)) and options ' +
          '{ kind?, to, onMissing, update } with functions to and update and a string kind.',
      );
    }
    if (onMissing !== undefined && onMissing !== 'report' && onMissing !== 'ignore') {
      this.fail(
        `.attach() for ${JSON.stringify(event.name)}: onMissing must be 'report' (the default: ` +
          "leave the state as it was and report the event) or 'ignore' (leave the state as it " +
          `was, silently); got ${JSON.stringify(onMissing)}.`,
      );
    }
    const { tag } = this;
    const reports = onMissing !== 'ignore';
    return this.handle('.attach()', event, (state, envelope, report) => {
      const current = state as AnySegmentedState;
      const id = to(envelope);
      const { segments } = current;
      for (let index = segments.length - 1; index >= 0; index--) {
        const segment = segments[index] as Segment<unknown>;
        if (segment.id !== id) continue;
        if (kind !== undefined && (segment.data as Record<string, unknown>)[tag] !== kind) continue;
        const data = update(segment.data, envelope);
        if (Object.is(data, segment.data)) return state;
        const next = [...segments];
        next[index] = { ...segment, data };
        return { ...current, segments: next };
      }
      // No target: the state stays as it was; the read reports it unless onMissing is 'ignore'.
      if (reports) report?.(envelope, kind === undefined ? { id } : { id, kind });
      return state;
    });
  }
}

/**
 * @internal A fold built by `SegmentedFold.of` (by class: a `ContextFold` whose state has segments
 * is not one).
 */
export function isSegmentedFold(value: unknown): value is AnySegmentedFold {
  return value instanceof SegmentedFoldImpl;
}

/**
 * Defines a segmented fold: its state is a list of segments (`SegmentedState`), described by
 * schemas. Events open segments (`open`) or update the one they belong to (`attach`). The
 * handlers are built from pure functions, so they never mutate a state. A compaction
 * (`folds.<name>.compact(...)`) replaces older segments with a `summary`.
 *
 * ```ts
 * const Conversation = SegmentedFold.of('conversation', {
 *   data: Entry, // S.Union of { kind: 'user' | 'step' | 'answer', … } structs
 *   summary: S.String, // what a compaction writes
 *   tag: 'kind',
 * })
 *   .open(UserPrompt, ({ meta, payload }) => ({
 *     id: `prompt:${meta.runId}`,
 *     data: { kind: 'user', text: payload.text },
 *   }))
 *   .open(ModelStep, ({ payload }) => ({
 *     id: payload.stepId,
 *     data: { kind: 'step', text: payload.text, toolCalls: payload.toolCalls, results: [] },
 *   }))
 *   .attach(ToolResult, {
 *     kind: 'step',
 *     to: ({ payload }) => payload.stepId,
 *     update: (step, { payload }) => ({ ...step, results: [...step.results, payload] }),
 *   });
 * ```
 */
export const SegmentedFold: {
  /**
   * Starts a segmented fold named `name` (a JS identifier: the accessor in `ctx.folds`) with no
   * segments. The `data` schema (and `summary`, if any) give the state type; `tag` names the
   * field `attach`'s `kind` narrows on. Validated like `ContextFold.of` (name, `scope`, `version`)
   * plus the schemas and the tag.
   */
  of<
    const Name extends string,
    Data extends S.Schema.AnyNoContext,
    Summary extends S.Schema.AnyNoContext = never,
    const Tag extends string = '_tag',
    const Scope extends FoldScope = 'context',
  >(
    name: Name & ValidFoldName<Name>,
    options: SegmentedFoldOptions<Data, Summary, Tag, Scope>,
  ): SegmentedFold<
    Name,
    Scope,
    S.Schema.Type<Data>,
    S.Schema.Type<Summary>,
    Tag,
    never,
    SegmentedState<S.Schema.Encoded<Data>, S.Schema.Encoded<Summary>>
  >;
} = {
  of<
    const Name extends string,
    Data extends S.Schema.AnyNoContext,
    Summary extends S.Schema.AnyNoContext = never,
    const Tag extends string = '_tag',
    const Scope extends FoldScope = 'context',
  >(
    name: Name & ValidFoldName<Name>,
    options: SegmentedFoldOptions<Data, Summary, Tag, Scope>,
  ): SegmentedFold<
    Name,
    Scope,
    S.Schema.Type<Data>,
    S.Schema.Type<Summary>,
    Tag,
    never,
    SegmentedState<S.Schema.Encoded<Data>, S.Schema.Encoded<Summary>>
  > {
    const { version, scope } = resolveFoldOptions('SegmentedFold', name, options);
    const fail = (detail: string) => foldDefinitionError('SegmentedFold', name, detail);
    const {
      data,
      summary,
      tag = DEFAULT_TAG,
    } = options ?? ({} as Partial<SegmentedFoldOptions<Data, Summary, Tag, Scope>>);
    if (!S.isSchema(data)) {
      throw fail(
        'the data option must be an Effect schema of the segment data, e.g. ' +
          'S.Union(S.TaggedStruct(...), ...).',
      );
    }
    if (summary !== undefined && !S.isSchema(summary)) {
      throw fail('the summary option must be an Effect schema (or left out).');
    }
    if (typeof tag !== 'string') {
      throw fail(
        'the tag option must name the field that tells the variants of the data apart ' +
          "(default '_tag'), e.g. 'kind'.",
      );
    }
    // As `AnyNoContext`: the context of a generic schema type does not resolve to `never`.
    const segments = S.Array(S.Struct({ id: S.String, data: data as S.Schema.AnyNoContext }));
    const stateSchema =
      summary === undefined
        ? S.Struct({ segments })
        : S.Struct({ summary: S.optional(summary as S.Schema.AnyNoContext), segments });
    return new SegmentedFoldImpl(
      {
        name,
        version,
        scope,
        stateSchema,
        initial: emptySegmentedState,
        eventNames: [],
        handlers: new Map(),
      },
      tag,
    ) as unknown as SegmentedFold<
      Name,
      Scope,
      S.Schema.Type<Data>,
      S.Schema.Type<Summary>,
      Tag,
      never,
      SegmentedState<S.Schema.Encoded<Data>, S.Schema.Encoded<Summary>>
    >;
  },
};
