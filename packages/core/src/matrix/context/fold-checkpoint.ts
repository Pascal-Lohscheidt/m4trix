import { Either, type ParseResult, Schema as S } from 'effect';
import type { EnvelopeLike, EventMeta } from '../agent-network/agent-network-event.js';
import { RESERVED_EVENT_PREFIX } from '../agent-network/run-lifecycle.js';
import { decodeStoredPayload, storedFormOf } from '../agent-network/stored-payload.js';
import type { AnyContextFold } from './context-fold.js';

/**
 * Fold checkpoints: the event the runtime publishes when an agent compacts a fold
 * (`folds.<name>.compact(...)`). It is stored with the run like any durable event, but published
 * to no channel: agents, subscribers and SSE clients never receive it; folds read it from the
 * store.
 */

const PREFIX = `${RESERVED_EVENT_PREFIX}fold.checkpoint:`;

/**
 * The name of the checkpoint events of the fold `Name`: `m4trix:fold.checkpoint:<name>@<version>`.
 * One name per fold name and version, so a fold only ever reads checkpoints of its own version.
 */
export type FoldCheckpointEventName<Name extends string = string> =
  `m4trix:fold.checkpoint:${Name}@${number}`;

/**
 * The payload of a fold checkpoint. `state` is the compacted state, encoded with the fold's
 * `state` schema (JSON-compatible); `through` is the cursor of the read that state was computed
 * from (`null`: the fold had read no event yet). A read restores `state` and folds the fold's
 * events after `through` on top of it again, so events published while the compaction ran are
 * kept.
 */
export type FoldCheckpointPayload = {
  /** The fold's name. */
  readonly fold: string;
  /** The fold's version (`ContextFoldOptions.version`). */
  readonly version: number;
  /** Cursor of the read the state was computed from; `null` before the fold read any event. */
  readonly through: string | null;
  /** The new state, encoded with the fold's `state` schema. */
  readonly state: unknown;
};

/** A fold checkpoint as it is stored (see `isFoldCheckpointEvent`). */
export type FoldCheckpointEnvelope = {
  readonly name: FoldCheckpointEventName;
  readonly meta: EventMeta;
  readonly payload: FoldCheckpointPayload;
};

/** The name of the checkpoint events of `fold`, for its name and version. */
export function foldCheckpointEventName<const Name extends string>(fold: {
  readonly name: Name;
  readonly version: number;
}): FoldCheckpointEventName<Name> {
  return `${PREFIX}${fold.name}@${fold.version}` as FoldCheckpointEventName<Name>;
}

/** What a reader needs of a checkpoint's payload; other fields are informational. */
const StoredPayload = S.Struct({ through: S.NullOr(S.String), state: S.Unknown });

/** @internal A checkpoint as a read restores it: the decoded state and its `through` cursor. */
export type RestoredCheckpoint = {
  readonly state: unknown;
  /** `undefined` for a checkpoint computed before the fold read any event (`through: null`). */
  readonly through: string | undefined;
};

/**
 * @internal Decodes the checkpoint `event` with the fold's `stateSchema`: its state and `through`,
 * or the `ParseError` of a payload that is not a checkpoint's or a state the schema rejects. A
 * state schema that does not transform restores the stored state itself (it is frozen; see
 * `decodeStoredPayload`), so restoring a large checkpoint copies nothing.
 */
export function restoreFoldCheckpoint(
  stateSchema: S.Schema.AnyNoContext,
  event: EnvelopeLike,
): Either.Either<RestoredCheckpoint, ParseResult.ParseError> {
  return Either.flatMap(S.decodeUnknownEither(StoredPayload)(event.payload), ({ through, state }) =>
    Either.map(decodeStoredPayload(stateSchema, state), (decoded) => ({
      state: decoded,
      through: through ?? undefined,
    })),
  );
}

/**
 * True for a checkpoint of any fold (by its name), e.g. to tell checkpoints apart when reading
 * `history.run()` or a store directly.
 */
export function isFoldCheckpointEvent<E extends { readonly name: string }>(
  event: E,
): event is E & FoldCheckpointEnvelope {
  return event.name.startsWith(PREFIX);
}

/**
 * Why `folds.<name>.compact()` rejected (`FoldCompactionError.reason`): `'invalid-state'`, the
 * new state does not encode with the fold's `state` schema (a wrong type, or a field the schema
 * does not know); `'unsupported'`, the fold cannot compact (no `state` schema, or run-scoped) or
 * there is no network to store its checkpoint in.
 */
export type FoldCompactionErrorReason = 'invalid-state' | 'unsupported';

/**
 * `folds.<name>.compact()` rejected before publishing anything: see `reason`. For
 * `'invalid-state'`, `cause` is the schema's `ParseError` (its message lists the issues).
 */
export class FoldCompactionError extends Error {
  /** Discriminant for `catch` / Effect error handling. */
  readonly _tag = 'FoldCompactionError' as const;
  /** The fold that was compacted. */
  readonly foldName: string;
  /** Why it rejected (see `FoldCompactionErrorReason`). */
  readonly reason: FoldCompactionErrorReason;
  /** The `ParseError` of an `'invalid-state'`. */
  readonly cause: unknown;

  constructor(
    foldName: string,
    reason: FoldCompactionErrorReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'FoldCompactionError';
    this.foldName = foldName;
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * @internal Throws `FoldCompactionError` (`'unsupported'`) unless `fold` can compact: a
 * context-scoped fold with a state schema, which is what gives it a checkpoint event name.
 */
export function assertCompactable(fold: AnyContextFold): asserts fold is AnyContextFold & {
  readonly checkpointEventName: string;
  readonly stateSchema: S.Schema.AnyNoContext;
} {
  if (fold.checkpointEventName !== undefined) return;
  throw new FoldCompactionError(
    fold.name,
    'unsupported',
    `folds.${fold.name}.compact(): only a context-scoped fold with a state schema can compact ` +
      '(ContextFold.of(name, { state }) or a SegmentedFold); its checkpoint stores the state ' +
      'encoded with that schema.',
  );
}

/**
 * @internal `state` encoded with the fold's state schema, strictly (a field the schema does not
 * know is an error, not dropped, so the stored checkpoint holds exactly the state), as the
 * deep-frozen JSON copy the store gets (see `toStoredJson`): the runtime stores it as it is,
 * without encoding it again. Throws `FoldCompactionError` (`'invalid-state'`), also for a state
 * schema whose encoded form is not JSON (e.g. `S.DateFromSelf`; `S.Date` encodes to a string).
 */
export function encodeFoldCheckpointState(
  fold: AnyContextFold & { readonly stateSchema: S.Schema.AnyNoContext },
  state: unknown,
): unknown {
  const encoded = S.encodeUnknownEither(fold.stateSchema)(state, { onExcessProperty: 'error' });
  if (Either.isLeft(encoded)) {
    throw new FoldCompactionError(
      fold.name,
      'invalid-state',
      `folds.${fold.name}.compact(): the new state does not match the fold's state schema: ` +
        encoded.left.message,
      encoded.left,
    );
  }
  const stored = storedFormOf(fold.stateSchema, encoded.right);
  if (Either.isRight(stored)) return stored.right;
  throw new FoldCompactionError(
    fold.name,
    'invalid-state',
    `folds.${fold.name}.compact(): the new state does not encode to JSON with the fold's ` +
      `state schema (checkpoints are stored as JSON): ${stored.left.message}`,
    stored.left,
  );
}
