/**
 * Type-safe no-operation stubs for use as default handlers.
 *
 * `noop` and `asyncNoop` are assignable to any callback that expects
 * additional parameters — TypeScript allows a function with fewer
 * parameters to substitute for one expecting more.
 *
 * @example
 * ```ts
 * type LogicFn = (ctx: { params: Config; emit: Emitter }) => Promise<void>;
 * const defaultLogic: LogicFn = asyncNoop;
 * ```
 */

/** Synchronous no-op — safe default for any `(...) => void` handler. */
export const noop = (): void => {};

/** Asynchronous no-op — safe default for any `(...) => Promise<void>` handler. */
export const asyncNoop = async (): Promise<void> => {};

/** Synchronous no-op that returns a given value — for handlers that must return `R`. */
export const noopOf =
  <R>(value: R): (() => R) =>
  () =>
    value;

/** Asynchronous no-op that resolves to a given value — for handlers that must return `Promise<R>`. */
export const asyncNoopOf =
  <R>(value: R): (() => Promise<R>) =>
  async () =>
    value;
