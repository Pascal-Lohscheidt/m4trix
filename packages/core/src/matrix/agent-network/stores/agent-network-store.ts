import type { EnvelopeLike } from '../agent-network-event.js';

/**
 * An event as the store keeps it: name, meta (including `runId` and `eventId`), its payload, and
 * the channels it was published to. The runtime appends a deep-frozen JSON copy: the payload
 * encoded with its event's schema (`S.encode`: a `Date` as an ISO string, an `Option` as
 * `{ _tag, value }`), so it shares no object with what agents received and survives a JSON round
 * trip unchanged. Reads (`history`, folds, resumed streams) return it in that encoded form; folds
 * decode it with the event's schema. Keep `channels`: resumed SSE streams (`Last-Event-ID`) replay
 * only the events of their own channel.
 */
export type StoredEvent = EnvelopeLike & {
  /** The channels the event was published to; absent on events stored before it existed. */
  readonly channels?: ReadonlyArray<string>;
};

/**
 * Identifies one conversation's history: a `contextId` within a tenant `namespace`. Every read and
 * write is scoped by both, so a client-supplied `contextId` never reaches another tenant's events.
 *
 * Keep both parts when deriving a backend key, and encode them unambiguously (e.g.
 * `JSON.stringify([namespace, contextId])`): a plain `${namespace}:${contextId}` lets
 * `principal:a` + `b:c` collide with `principal:a:b` + `c`.
 */
export type AgentNetworkStoreKey = {
  /**
   * The tenant: `principal:<id>` for an authenticated principal, `anonymous` otherwise (see
   * `principalNamespace`). Never empty. Treat it as opaque.
   */
  readonly namespace: string;
  readonly contextId: string;
};

export type ReadContextOptions = {
  /**
   * Max events to return. Reading backward (without `after`): the newest `limit` (before
   * `before`, when given). Reading forward (with `after`): the oldest `limit` after the cursor.
   * Default: all of them.
   */
  readonly limit?: number;
  /** A `cursor` from an earlier page: only events appended before that page are returned. */
  readonly before?: string;
  /**
   * A `head` (or a `readLatest` cursor): only events appended after the event it points at are
   * returned, oldest first, so `limit` pages forward. Cannot be combined with `before`.
   */
  readonly after?: string;
  /**
   * Only events with one of these names. Cursors stay positions in the whole context, so a
   * filtered page's `cursor` and `head` page on consistently, also when events with other names
   * are appended in between. `history` never passes an empty list.
   */
  readonly names?: readonly string[];
};

/**
 * A page of a context's events, oldest first. Cursors are opaque positions in the context's log:
 * they stay valid while newer events are appended.
 */
export type EventPage = {
  readonly events: readonly StoredEvent[];
  /**
   * Pass it as `before` to read the page of older events. Absent once no older events (with one
   * of `names`, when given) remain, and on pages read with `after`.
   */
  readonly cursor?: string;
  /**
   * A cursor at the page's newest event: pass it as `after` to read only the events appended
   * after this page. Present whenever the page is non-empty.
   */
  readonly head?: string;
  /**
   * Set on a page read with an `after` cursor that does not belong to the context's current
   * history: the context was deleted, expired or evicted since the cursor was handed out (and
   * may have started over), or the store does not recognise the cursor at all (another store's,
   * e.g. in a migrated history). The page then holds the current history from its start, as if
   * read without `after`. Anything derived from pages before the cursor is stale; folds rebuild.
   */
  readonly reset?: true;
};

/**
 * Durable event history of a network, read by agents through `ctx.history`. Implement it to keep
 * history in Redis, Postgres, etc., and pass it as `AgentNetwork.setup(cb, { store })`; check an
 * implementation with `runStoreContract` from `@m4trix/core/testing`.
 *
 * The runtime appends each durable event before delivering it, and never has two appends for the
 * same run in flight; appends to different runs or contexts may run concurrently.
 *
 * What the runtime relies on:
 * - Events are JSON-compatible (see `StoredEvent`): store them as JSON and return them unchanged,
 *   `channels` included, without turning values into others (e.g. reviving date strings).
 * - Positions only grow: an appended event becomes visible after every cursor already handed out,
 *   never before one (a store that numbers events before its transaction commits must not let a
 *   lower number commit after a higher one was read). Folds read only the events after their
 *   cursor, so an event that lands before it is never folded.
 * - Cursors are persisted (fold checkpoints keep the cursor of the read they were computed from):
 *   keep their format stable across versions and restarts of the store; a cursor the store does
 *   not recognise reads as a `reset` page (see `readContext`).
 */
export interface AgentNetworkStore {
  /**
   * Appends `event` to the context's log (its run is `event.meta.runId`). Resolve only once the
   * event is durable; reject on failure (the runtime retries, then fails the run).
   */
  append(key: AgentNetworkStoreKey, event: StoredEvent): Promise<void>;
  /** Every event of one run of the context, in append order; empty when there are none. */
  readRun(key: AgentNetworkStoreKey, runId: string): Promise<readonly StoredEvent[]>;
  /**
   * The context's events across its runs, in append order: the newest `limit` (before the
   * `before` cursor, when given), or the oldest `limit` after the `after` cursor; only those with
   * one of `names`, when given. A cursor stays valid while newer events are appended. Reject when
   * both `after` and `before` are given.
   *
   * An `after` cursor of a history that is gone (deleted, expired, evicted, also when the context
   * has started over since) must not be read as a position in the current one: return the
   * current history from its start with `reset: true` (see `EventPage.reset`). The same for an
   * `after` cursor the store does not recognise: a reset page, not an error. Folds rely on it to
   * never add new events onto state derived from a deleted history, and to stay readable when a
   * stored checkpoint carries a foreign cursor.
   *
   * Cursors are persisted (fold checkpoints keep the cursor of the read they were computed
   * from), so keep their format stable across versions of the store, and keep each event's
   * `channels`: they decide which streams an event is replayed to. An event appended while a
   * cursor is out must show up after it, never before it.
   */
  readContext(key: AgentNetworkStoreKey, options?: ReadContextOptions): Promise<EventPage>;
  /**
   * Optional, for stores that can look it up cheaply (e.g. an index on the event name): the
   * context's newest event with one of `names`, and a cursor at it to pass as `after`; `undefined`
   * when there is none. Without it, `history.latest` reads `readContext({ names, limit: 1 })`.
   */
  readLatest?(
    key: AgentNetworkStoreKey,
    names: readonly string[],
  ): Promise<{ readonly event: StoredEvent; readonly cursor: string } | undefined>;
  /** Deletes the context's events (in that namespace only), e.g. when a user clears a chat. */
  deleteContext?(key: AgentNetworkStoreKey): Promise<void>;
}

/** Namespace of requests without a principal (no `auth`, or `auth` returned none). */
export const ANONYMOUS_NAMESPACE = 'anonymous';

/**
 * The store namespace of a principal id: `principal:<id>`, or `anonymous` without one. The prefix
 * keeps a principal whose id is `anonymous` out of the anonymous namespace.
 */
export const principalNamespace = (principalId: string | undefined): string =>
  principalId === undefined ? ANONYMOUS_NAMESPACE : `principal:${principalId}`;
