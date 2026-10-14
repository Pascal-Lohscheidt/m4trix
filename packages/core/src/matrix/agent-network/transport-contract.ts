import { Effect, Exit, Fiber, Option, Scope } from 'effect';
import type { Envelope } from './event-plane.js';
import type { EventTransport } from './event-transport.js';
import type { StoreContractTestApi } from './stores/store-contract.js';

/** The test functions `runTransportContract` registers its cases with (as for the store). */
export type TransportContractTestApi = StoreContractTestApi;

/** Creates the transport under test; called once per case. */
export type CreateTransport = () => EventTransport | Promise<EventTransport>;

let uniqueCounter = 0;
const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(uniqueCounter++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const envelope = (name: string, extra: Partial<Envelope['meta']> = {}): Envelope => ({
  name,
  meta: { runId: 'run-1', contextId: 'ctx-1', eventId: unique('evt'), ...extra },
  payload: { name },
});

/** How long a case waits for a delivery that should happen, or makes sure one does not. */
const SETTLE_MS = 50;
const WAIT_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `ready()` holds, or after `WAIT_MS` (the assertions that follow then fail). */
async function eventually(ready: () => boolean): Promise<void> {
  const until = Date.now() + WAIT_MS;
  while (!ready() && Date.now() < until) await sleep(5);
}

/** A subscription to `channel` collecting names, open until `close()`. */
async function collecting(transport: EventTransport, channel: string) {
  const scope = Effect.runSync(Scope.make());
  const received: string[] = [];
  await Effect.runPromise(
    Scope.extend(
      transport.subscribe(channel, (e) =>
        Effect.sync(() => {
          received.push(e.name);
        }),
      ),
      scope,
    ),
  );
  return { received, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

/** Channel names unique to the case, so a transport shared between cases (e.g. one broker) still passes. */
const channelsFor = () => ({ a: unique('chan-a'), b: unique('chan-b') });

/**
 * Registers the `EventTransport` contract as test cases, for checking a transport (e.g. one
 * backed by Redis Streams or NATS) with the test runner of your choice:
 *
 * ```ts
 * import { describe, expect, it } from 'vitest';
 * import { runTransportContract } from '@m4trix/core/testing';
 *
 * runTransportContract({ describe, it, expect }, () => createRedisTransport(redis));
 * ```
 *
 * Deliveries may be asynchronous: a case waits up to two seconds for one that should arrive.
 * Every case uses its own channel names, so the transport may be shared between cases.
 */
export function runTransportContract(
  test: TransportContractTestApi,
  createTransport: CreateTransport,
): void {
  const { describe, it, expect } = test;

  describe('EventTransport contract', () => {
    describe('publish and subscribe', () => {
      it('delivers a published event to every subscriber of its channels, once each', async () => {
        const transport = await createTransport();
        const { a, b } = channelsFor();
        const first = await collecting(transport, a);
        const second = await collecting(transport, a);
        const other = await collecting(transport, b);

        await Effect.runPromise(transport.publish([a], envelope('hello')));
        await eventually(() => first.received.length > 0 && second.received.length > 0);
        await sleep(SETTLE_MS);

        expect(first.received).toEqual(['hello']);
        expect(second.received).toEqual(['hello']);
        expect(other.received).toEqual([]);
        await Promise.all([first.close(), second.close(), other.close()]);
      });

      it('delivers an event published to several channels on each of them', async () => {
        const transport = await createTransport();
        const { a, b } = channelsFor();
        const onA = await collecting(transport, a);
        const onB = await collecting(transport, b);

        await Effect.runPromise(transport.publish([a, b], envelope('both')));
        await eventually(() => onA.received.length > 0 && onB.received.length > 0);

        expect(onA.received).toEqual(['both']);
        expect(onB.received).toEqual(['both']);
        await Promise.all([onA.close(), onB.close()]);
      });

      it('keeps the publish order for each subscriber', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const sub = await collecting(transport, a);

        for (const name of ['e1', 'e2', 'e3', 'e4', 'e5']) {
          await Effect.runPromise(transport.publish([a], envelope(name)));
        }
        await eventually(() => sub.received.length >= 5);

        expect(sub.received).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
        await sub.close();
      });

      it('delivers only events published after subscribing', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        await Effect.runPromise(transport.publish([a], envelope('early')));
        const sub = await collecting(transport, a);

        await Effect.runPromise(transport.publish([a], envelope('late')));
        await eventually(() => sub.received.length > 0);
        await sleep(SETTLE_MS);

        expect(sub.received).toEqual(['late']);
        await sub.close();
      });

      it('stops delivering once the subscription scope closes', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const sub = await collecting(transport, a);
        await sub.close();

        await Effect.runPromise(transport.publish([a], envelope('after-close')));
        await sleep(SETTLE_MS);

        expect(sub.received).toEqual([]);
      });

      it('delivers the envelope unchanged', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const seen: Envelope[] = [];
        const scope = Effect.runSync(Scope.make());
        await Effect.runPromise(
          Scope.extend(
            transport.subscribe(a, (e) =>
              Effect.sync(() => {
                seen.push(e);
              }),
            ),
            scope,
          ),
        );
        const sent: Envelope = {
          name: 'rich',
          meta: {
            runId: 'run-9',
            contextId: 'ctx-9',
            eventId: unique('evt'),
            correlationId: 'corr-1',
            causationId: 'cause-1',
            ts: 1_700_000_000_000,
            depth: 2,
            principalId: 'alice',
          },
          payload: { text: 'hi', nested: { list: [1, 2], flag: true, none: null } },
        };

        await Effect.runPromise(transport.publish([a], sent));
        await eventually(() => seen.length > 0);

        expect(seen).toEqual([sent]);
        await Effect.runPromise(Scope.close(scope, Exit.void));
      });

      it('a failing subscriber neither fails the publish nor starves the other subscribers', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const scope = Effect.runSync(Scope.make());
        await Effect.runPromise(
          Scope.extend(
            transport.subscribe(a, () => Effect.die(new Error('subscriber bug'))),
            scope,
          ),
        );
        const healthy = await collecting(transport, a);

        const exit = await Effect.runPromiseExit(transport.publish([a], envelope('x')));
        await eventually(() => healthy.received.length > 0);

        expect(Exit.isSuccess(exit)).toEqual(true);
        expect(healthy.received).toEqual(['x']);
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await healthy.close();
      });
    });

    describe('request / reply', () => {
      it('resolves with the first matching event published after registering', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const request = envelope('ask', { correlationId: 'c-1' });
        const reply = envelope('answer', { correlationId: 'c-1' });

        const answer = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const awaitReply = yield* transport.expectReply(
                request,
                (e) => e.meta.correlationId === 'c-1',
              );
              yield* transport.publish([a], request);
              yield* transport.publish([a], envelope('noise', { correlationId: 'c-2' }));
              yield* transport.publish([a], reply);
              return yield* awaitReply.pipe(Effect.timeout(`${WAIT_MS} millis`));
            }),
          ),
        );

        expect(answer).toEqual(reply);
      });

      it('never takes the request itself as its reply', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const request = envelope('ask', { correlationId: 'c-1' });

        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const awaitReply = yield* transport.expectReply(request, () => true);
              yield* transport.publish([a], request);
              return yield* awaitReply.pipe(Effect.timeout(`${SETTLE_MS} millis`));
            }),
          ),
        );

        expect(Exit.isFailure(exit)).toEqual(true);
      });

      it('sees replies published to no channel at all', async () => {
        const transport = await createTransport();
        const request = envelope('ask', { correlationId: 'c-3' });
        const reply = envelope('answer', { correlationId: 'c-3' });

        const answer = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const awaitReply = yield* transport.expectReply(
                request,
                (e) => e.meta.correlationId === 'c-3',
              );
              yield* transport.publish([], reply);
              return yield* awaitReply.pipe(Effect.timeout(`${WAIT_MS} millis`));
            }),
          ),
        );

        expect(answer.name).toEqual('answer');
      });

      it('ignores replies published before registering, and stops waiting once its scope closes', async () => {
        const transport = await createTransport();
        const { a } = channelsFor();
        const request = envelope('ask', { correlationId: 'c-4' });
        const matches = (e: Envelope) => e.meta.correlationId === 'c-4';
        await Effect.runPromise(
          transport.publish([a], envelope('early', { correlationId: 'c-4' })),
        );

        const early = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.flatMap(transport.expectReply(request, matches), (awaitReply) =>
              awaitReply.pipe(Effect.timeout(`${SETTLE_MS} millis`)),
            ),
          ),
        );
        expect(Exit.isFailure(early)).toEqual(true);

        // A waiter whose scope closed is gone: a later reply does not reach it.
        const scope = Effect.runSync(Scope.make());
        const closedWaiter = await Effect.runPromise(
          Scope.extend(transport.expectReply(request, matches), scope),
        );
        const fiber = Effect.runFork(closedWaiter);
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await Effect.runPromise(transport.publish([a], envelope('late', { correlationId: 'c-4' })));
        await sleep(SETTLE_MS);

        expect(Option.isNone(Effect.runSync(Fiber.poll(fiber)))).toEqual(true);
        await Effect.runPromise(Fiber.interrupt(fiber));
      });
    });
  });
}
