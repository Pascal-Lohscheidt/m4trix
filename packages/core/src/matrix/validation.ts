import { Either, type ParseResult, Schema as S } from 'effect';
import type { AgentNetworkEventDef } from './agent-network/agent-network-event.js';
import { type ToolIssue, toToolIssues } from './tool-errors.js';

/**
 * One schema violation, located by a path such as `user.id` or `tags[1]` (`''` is the root).
 * The same shape tools report (`ToolIssue`).
 */
export type ValidationIssue = ToolIssue;

/** Path-level issues of a schema decode failure. */
export const toValidationIssues = (error: ParseResult.ParseError): ReadonlyArray<ValidationIssue> =>
  toToolIssues(error);

function formatIssueList(issues: ReadonlyArray<ValidationIssue>): string {
  return issues
    .map((issue) => `- ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
    .join('\n');
}

/** `AgentFactory.produce(params)` was given params that do not match the factory's `params()` schema. */
export class AgentParamsError extends Error {
  readonly _tag = 'AgentParamsError' as const;
  readonly issues: ReadonlyArray<ValidationIssue>;

  constructor(issues: ReadonlyArray<ValidationIssue>) {
    super(`Invalid agent params:\n${formatIssueList(issues)}`);
    this.name = 'AgentParamsError';
    this.issues = issues;
  }
}

/**
 * Checks `value` against `schema`. A value that already is exactly of the schema's type (e.g.
 * from `event.make()`) passes as is, by reference; anything else is decoded from the schema's
 * encoded form, so transformations apply and excess properties are dropped. A value of the
 * schema's type that only carries excess properties is accepted without them. On failure, `Left`
 * holds the issues of the decode attempt.
 */
export function decodeOrAccept<A, I, R>(
  schema: S.Schema<A, I, R>,
  value: unknown,
): Either.Either<A, ReadonlyArray<ValidationIssue>> {
  const typed = schema as S.Schema<A, I, never>;
  if (S.is(typed, { onExcessProperty: 'error' })(value)) return Either.right(value);
  const decoded = S.decodeUnknownEither(typed, { errors: 'all' })(value);
  if (Either.isRight(decoded)) return Either.right(decoded.right);
  const valid = S.validateEither(typed)(value);
  if (Either.isRight(valid)) return Either.right(valid.right);
  return Either.left(toValidationIssues(decoded.left));
}

/**
 * Why an emit was refused: the event is not among the emitter's declared `emits` (`undeclared`,
 * also for reserved `m4trix:*` names), its payload does not match the event's schema
 * (`invalid-payload`), or none of the channels the agent publishes to accepts it (`channel`, see
 * `channel.events([...])`).
 */
export type EmitViolation = 'undeclared' | 'invalid-payload' | 'channel';

type EmitValidationErrorOptions = {
  eventName: string;
  agentId?: string;
  toolName?: string;
  reason: EmitViolation;
  issues?: ReadonlyArray<ValidationIssue>;
  /** What the emitter may emit (`undeclared`) or where it publishes (`channel`). */
  allowed?: ReadonlyArray<string>;
};

/**
 * An agent (or a tool bound to it) emitted an event it may not: thrown by `emit`, and
 * `emitAndAwait` rejects with it. The event is not published. Inside a network the invocation
 * fails with it even when the agent catches it, so the network's `onAgentError` policy applies
 * (run failure kind `invalid-emit`). The message names the event and the offending paths but
 * never quotes payload values; `issues` carries the full schema messages.
 */
export class EmitValidationError extends Error {
  readonly _tag = 'EmitValidationError' as const;
  readonly eventName: string;
  /** The emitting agent; `undefined` for a tool bound outside an agent. */
  readonly agentId: string | undefined;
  /** Set when a tool emitted the event. */
  readonly toolName: string | undefined;
  readonly reason: EmitViolation;
  /** Schema issues for `invalid-payload`; empty otherwise. */
  readonly issues: ReadonlyArray<ValidationIssue>;
  readonly #options: EmitValidationErrorOptions;

  constructor(options: EmitValidationErrorOptions) {
    super(emitErrorMessage(options));
    this.name = 'EmitValidationError';
    this.eventName = options.eventName;
    this.agentId = options.agentId;
    this.toolName = options.toolName;
    this.reason = options.reason;
    this.issues = options.issues ?? [];
    this.#options = options;
  }

  /** @internal This error, attributed to `source` where it does not name an emitter yet. */
  withSource(source: EmitSource): EmitValidationError {
    const agentId = this.agentId ?? source.agentId;
    const toolName = this.toolName ?? source.toolName;
    if (agentId === this.agentId && toolName === this.toolName) return this;
    return new EmitValidationError({ ...this.#options, agentId, toolName });
  }
}

/** True for an `EmitValidationError`, also one from another copy of this module. */
export function isEmitValidationError(error: unknown): error is EmitValidationError {
  return (
    error instanceof EmitValidationError ||
    (error instanceof Error && (error as { _tag?: unknown })._tag === 'EmitValidationError')
  );
}

function emitErrorMessage(options: EmitValidationErrorOptions): string {
  const { eventName, agentId, toolName, reason } = options;
  const agent = agentId === undefined ? undefined : `agent "${agentId}"`;
  const who = toolName
    ? `Tool "${toolName}"${agent ? ` (${agent})` : ''}`
    : agent
      ? `Agent "${agentId}"`
      : 'Emitter';
  const list = (names: ReadonlyArray<string> | undefined): string =>
    names && names.length > 0 ? names.map((n) => `"${n}"`).join(', ') : 'none';
  switch (reason) {
    case 'undeclared':
      return `${who} emitted "${eventName}", which is not among its declared emits (${list(options.allowed)})`;
    case 'invalid-payload': {
      // Paths only: issue messages quote the offending values, which must not reach clients.
      const paths = [
        ...new Set((options.issues ?? []).map((i) => (i.path === '' ? '(root)' : i.path))),
      ];
      return `${who} emitted "${eventName}" with a payload that does not match its schema (at ${paths.join(', ')})`;
    }
    case 'channel':
      return `${who} emitted "${eventName}", which none of the channels it publishes to accepts (${list(options.allowed)})`;
  }
}

/* ─── Emit guards ─── */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/** Who emits: an agent, a tool, or a tool bound to an agent. */
export type EmitSource = { readonly agentId?: string; readonly toolName?: string };

/** @internal What an emit guard checks against and whom it tells about violations. */
export type EmitGuardOptions = {
  /** The events the emitter declared (`emits([...])`). */
  readonly emits: ReadonlyArray<EventDef>;
  readonly source: EmitSource;
  /** Told about every violation, before it is thrown. */
  readonly onInvalidEmit?: (error: EmitValidationError) => void;
};

/**
 * @internal The event as it is published: `event` checked against the declared `emits`, its
 * payload decoded with the event's schema. Throws `EmitValidationError`.
 */
export function validateEmit(
  emits: ReadonlyArray<EventDef>,
  event: unknown,
  source: EmitSource,
): { name: string; payload: unknown } {
  const candidate = (typeof event === 'object' && event !== null ? event : {}) as {
    name?: unknown;
    payload?: unknown;
  };
  const eventName = String(candidate.name);
  const def = emits.find((e) => e.name === candidate.name);
  if (!def) {
    throw new EmitValidationError({
      eventName,
      ...source,
      reason: 'undeclared',
      allowed: [...new Set(emits.map((e) => e.name))],
    });
  }
  const decoded = decodeOrAccept(def.payload, candidate.payload);
  if (Either.isLeft(decoded)) {
    throw new EmitValidationError({
      eventName,
      ...source,
      reason: 'invalid-payload',
      issues: decoded.left,
    });
  }
  return { name: def.name, payload: decoded.right };
}

/** Runs `fn`; an `EmitValidationError` it throws is attributed to the source and reported. */
function reportingInvalidEmits<T>(options: EmitGuardOptions, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (!isEmitValidationError(error)) throw error;
    const attributed = error.withSource(options.source);
    options.onInvalidEmit?.(attributed);
    throw attributed;
  }
}

/** @internal `emit`, publishing only valid events (decoded) and throwing on the rest. */
export function guardEmit<E>(
  emit: (event: E) => void,
  options: EmitGuardOptions,
): (event: E) => void {
  return (event) =>
    reportingInvalidEmits(options, () =>
      emit(validateEmit(options.emits, event, options.source) as E),
    );
}

/** @internal `emitAndAwait`, rejecting with `EmitValidationError` for invalid events. */
export function guardEmitAndAwait<E, TRest extends unknown[], R>(
  emitAndAwait: (event: E, ...rest: TRest) => Promise<R>,
  options: EmitGuardOptions,
): (event: E, ...rest: TRest) => Promise<R> {
  return (event, ...rest) => {
    try {
      return reportingInvalidEmits(options, () =>
        emitAndAwait(validateEmit(options.emits, event, options.source) as E, ...rest),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  };
}
