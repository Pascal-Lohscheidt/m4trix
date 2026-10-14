import { Deferred, Effect, Exit, FiberId, type Scope } from 'effect';
import type { Envelope } from './event-plane.js';

/**
 * Carries a network's events between publishers and subscribers: the fan-out of each channel and
 * the matching of `emitAndAwait` replies. The event plane keeps everything per run above it
 * (mailboxes, ordering, limits, ownership, run ends) and stores durable events before handing
 * them over.
 *
 * The default, `createInMemoryTransport()`, connects the planes of one process. A transport
 * backed by Redis Streams, NATS or Kafka can implement the same interface to connect the planes
 * of several instances (see the deployment guide); check one with `runTransportContract` from
 * `@m4trix/core/testing`.
 */
export type EventTransport = {
  /**
   * Hands `envelope` to every subscriber of each of `channels` (once per subscription), and to
   * every reply waiter it matches, published to no channel too. A failing subscriber never fails
   * the publish.
   *
   * The in-memory transport completes once every subscriber's handler completed: a slow
   * subscriber holds back the publisher (back-pressure). A broker-backed transport may complete
   * once the broker accepted the event, and deliver it asynchronously.
   */
  readonly publish: (channels: ReadonlyArray<string>, envelope: Envelope) => Effect.Effect<void>;
  /**
   * Calls `handler` with every event published to `channel` from now on, in publish order, until
   * the scope closes. The handler's completion acknowledges the event: a transport hands a
   * subscription its next event only after that (in-memory, it also holds back the publisher).
   */
  readonly subscribe: (
    channel: string,
    handler: (envelope: Envelope) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Registers a waiter for a reply to `request`: the first event published from now on, other
   * than the request itself (same `meta.eventId`), that `match` accepts, on any channel or none.
   * Returns the effect that waits for it; the waiter is dropped when the scope closes. Register
   * before publishing the request, so a fast reply is not missed.
   *
   * Replies of `emitAndAwait` carry the request's `meta.correlationId`, so a distributed transport
   * can route them to the instance that waits; `match` itself never leaves the process.
   */
  readonly expectReply: (
    request: Envelope,
    match: (reply: Envelope) => boolean,
  ) => Effect.Effect<Effect.Effect<Envelope>, never, Scope.Scope>;
};

type Handler = (envelope: Envelope) => Effect.Effect<void>;

type Waiter = {
  readonly request: Envelope;
  readonly match: (reply: Envelope) => boolean;
  readonly reply: Deferred.Deferred<Envelope>;
};

/**
 * The in-process `EventTransport`, the default of every event plane: subscribers and reply
 * waiters of this process only. Pass one instance as the network's `transport` to connect all
 * planes of the network in this process (e.g. per-request `expose()` planes).
 */
export const createInMemoryTransport = (): EventTransport => {
  const subscribers = new Map<string, Set<Handler>>();
  const waiters = new Set<Waiter>();

  const isRequest = (waiter: Waiter, envelope: Envelope): boolean =>
    waiter.request === envelope ||
    (waiter.request.meta.eventId !== undefined &&
      waiter.request.meta.eventId === envelope.meta.eventId);

  /** Resolves the waiters `envelope` answers; a throwing `match` fails its own waiter only. */
  const resolveWaiters = (envelope: Envelope): void => {
    for (const waiter of waiters) {
      if (isRequest(waiter, envelope)) continue;
      let matched: boolean;
      try {
        matched = waiter.match(envelope);
      } catch (error) {
        waiters.delete(waiter);
        Deferred.unsafeDone(waiter.reply, Exit.die(error));
        continue;
      }
      if (matched) {
        waiters.delete(waiter);
        Deferred.unsafeDone(waiter.reply, Exit.succeed(envelope));
      }
    }
  };

  const publish: EventTransport['publish'] = (channels, envelope) =>
    Effect.suspend(() => {
      resolveWaiters(envelope);
      const handlers = channels.flatMap((channel) => [...(subscribers.get(channel) ?? [])]);
      return Effect.forEach(
        handlers,
        // A subscriber's failure is its own: the publisher and the other subscribers carry on.
        (handler) =>
          Effect.suspend(() => handler(envelope)).pipe(Effect.catchAllCause(() => Effect.void)),
        { concurrency: 'unbounded', discard: true },
      );
    });

  const subscribe: EventTransport['subscribe'] = (channel, handler) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let set = subscribers.get(channel);
        if (!set) {
          set = new Set();
          subscribers.set(channel, set);
        }
        // Wrapped so subscribing one handler twice yields two subscriptions.
        const subscription: Handler = (envelope) => handler(envelope);
        set.add(subscription);
        return { set, subscription };
      }),
      ({ set, subscription }) =>
        Effect.sync(() => {
          set.delete(subscription);
          if (set.size === 0 && subscribers.get(channel) === set) subscribers.delete(channel);
        }),
    ).pipe(Effect.asVoid);

  const expectReply: EventTransport['expectReply'] = (request, match) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const waiter: Waiter = {
          request,
          match,
          reply: Deferred.unsafeMake<Envelope>(FiberId.none),
        };
        waiters.add(waiter);
        return waiter;
      }),
      (waiter) => Effect.sync(() => waiters.delete(waiter)),
    ).pipe(Effect.map((waiter) => Deferred.await(waiter.reply)));

  return { publish, subscribe, expectReply };
};
