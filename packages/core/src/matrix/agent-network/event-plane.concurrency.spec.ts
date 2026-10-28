import { Effect, Fiber, Layer, Queue, Schema as S, Tracer } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ChannelName } from '../identifiers/channel-name.js';
import type { NetworkTracer } from '../tracing/network-tracer.js';
import { noopRunTraceScope } from '../tracing/network-tracer.js';
import { AgentNetwork } from './agent-network.js';
import { AgentNetworkEvent, type AgentNetworkEventDef } from './agent-network-event.js';
import { type Envelope, inspectEventPlane } from './event-plane.js';

const job = AgentNetworkEvent.of('job', S.Struct({ n: S.Number }));
const tick = AgentNetworkEvent.of('tick', S.Struct({ n: S.Number }), { transient: true });
const done = AgentNetworkEvent.of('done', S.Struct({ n: S.Number }));

const main = ChannelName('main');
const client = ChannelName('client');
const side = ChannelName('side');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `done()` holds instead of sleeping a fixed time: on a loaded CI machine the agents
 * can take far longer than locally. Fails after `ms` if it never holds.
 */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await sleep(5);
  }
}

/** A promise with its resolver, for holding an agent until the test lets it go. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Counts concurrent invocations, overall and per run. */
function inFlightTracker() {
  const perRun = new Map<string, number>();
  const maxPerRun = new Map<string, number>();
  let current = 0;
  let max = 0;
  return {
    enter(runId: string): void {
      current++;
      max = Math.max(max, current);
      const n = (perRun.get(runId) ?? 0) + 1;
      perRun.set(runId, n);
      maxPerRun.set(runId, Math.max(maxPerRun.get(runId) ?? 0, n));
    },
    leave(runId: string): void {
      current--;
      perRun.set(runId, (perRun.get(runId) ?? 1) - 1);
    },
    get max() {
      return max;
    },
    maxFor: (runId: string) => maxPerRun.get(runId) ?? 0,
  };
}

const meta = (runId: string) => ({ runId, contextId: 'ctx' });

describe('event plane concurrency', () => {
  test("run A's slow invocation does not delay the same agent handling run B", async () => {
    const holdA = gate();
    let aInFlight = false;
    const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
      const out = createChannel('client');
      registerAgent(
        AgentFactory.run()
          .listensTo([job])
          .emits([done])
          .logic(async ({ triggerEvent, emit }) => {
            if (triggerEvent.meta.runId === 'run-a') {
              aInFlight = true;
              await Promise.race([holdA.wait, sleep(500)]);
              aInFlight = false;
            }
            emit(done.make({ n: triggerEvent.payload.n }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(out);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      const out = yield* plane.subscribe(client);
      yield* plane.publish(main, job.makeBound(meta('run-a'), { n: 1 }));
      yield* plane.publish(main, job.makeBound(meta('run-b'), { n: 2 }));

      const first = yield* Queue.take(out);
      const aWasStillRunning = aInFlight;
      holdA.open();
      const second = yield* Queue.take(out);
      return { first, second, aWasStillRunning };
    });

    const { first, second, aWasStillRunning } = await Effect.runPromise(
      program.pipe(Effect.scoped),
    );

    expect(first.meta.runId).toBe('run-b');
    expect(aWasStillRunning).toBe(true);
    expect(second.meta.runId).toBe('run-a');
  });

  test('within a run an agent sees its events in order, one at a time; runs overlap', async () => {
    const tracker = inFlightTracker();
    const seen = new Map<string, number[]>();
    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      registerAgent(
        AgentFactory.run()
          .listensTo([job])
          .logic(async ({ triggerEvent }) => {
            const { runId } = triggerEvent.meta;
            tracker.enter(runId);
            // Later events finish faster: overlapping invocations would reorder them.
            await sleep(12 - 2 * triggerEvent.payload.n);
            seen.set(runId, [...(seen.get(runId) ?? []), triggerEvent.payload.n]);
            tracker.leave(runId);
          })
          .produce({}),
      ).subscribe(mainChannel);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      for (let n = 0; n < 5; n++) {
        yield* plane.publish(main, job.makeBound(meta('run-1'), { n }));
        yield* plane.publish(main, job.makeBound(meta('run-2'), { n }));
      }
      yield* Effect.promise(() =>
        until(() => ['run-1', 'run-2'].every((runId) => (seen.get(runId)?.length ?? 0) >= 5)),
      );
    });

    await Effect.runPromise(program.pipe(Effect.scoped));

    for (const runId of ['run-1', 'run-2']) {
      expect(seen.get(runId)).toEqual([0, 1, 2, 3, 4]);
      expect(tracker.maxFor(runId)).toBe(1);
    }
    expect(tracker.max).toBe(2);
  });

  test('.concurrency(n) caps concurrent invocations of an agent across runs', async () => {
    const tracker = inFlightTracker();
    let finished = 0;
    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      registerAgent(
        AgentFactory.run()
          .listensTo([job])
          .concurrency(2)
          .logic(async ({ triggerEvent }) => {
            tracker.enter(triggerEvent.meta.runId);
            await sleep(15);
            tracker.leave(triggerEvent.meta.runId);
            finished++;
          })
          .produce({}),
      ).subscribe(mainChannel);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      for (let n = 0; n < 6; n++) {
        yield* plane.publish(main, job.makeBound(meta(`run-${n}`), { n }));
      }
      yield* Effect.promise(() => until(() => finished >= 6));
    });

    await Effect.runPromise(program.pipe(Effect.scoped));

    expect(finished).toBe(6);
    expect(tracker.max).toBe(2);
  });

  test('a full mailbox of run A blocks only run A; transient events slide instead', async () => {
    const holdA = gate();
    const seen: string[] = [];
    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      registerAgent(
        AgentFactory.run()
          .listensTo([job, tick])
          .logic(async ({ triggerEvent }) => {
            const { runId } = triggerEvent.meta;
            seen.push(`${runId}:${triggerEvent.name}:${triggerEvent.payload.n}`);
            if (runId === 'run-a' && triggerEvent.name === 'job' && triggerEvent.payload.n === 1) {
              await holdA.wait;
            }
          })
          .produce({}),
      ).subscribe(mainChannel);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run({ capacity: 2 });
      // Job 1 is taken and held; job 2 and one tick fill the mailbox.
      yield* plane.publish(main, job.makeBound(meta('run-a'), { n: 1 }));
      yield* Effect.promise(() => sleep(10));
      yield* plane.publish(main, job.makeBound(meta('run-a'), { n: 2 }));
      yield* plane.publish(main, tick.makeBound(meta('run-a'), { n: 1 }));
      // Transient events never block: each replaces the oldest buffered tick.
      yield* plane
        .publish(main, tick.makeBound(meta('run-a'), { n: 2 }))
        .pipe(Effect.timeoutFail({ duration: '50 millis', onTimeout: () => 'tick 2 blocked' }));
      yield* plane
        .publish(main, tick.makeBound(meta('run-a'), { n: 3 }))
        .pipe(Effect.timeoutFail({ duration: '50 millis', onTimeout: () => 'tick 3 blocked' }));
      // A durable event for the full mailbox waits for room...
      const blockedA = yield* Effect.fork(
        plane.publish(main, job.makeBound(meta('run-a'), { n: 3 })),
      );
      yield* Effect.promise(() => sleep(20));
      const aBlocked = blockedA.unsafePoll() === null;
      // ...while run B goes straight through.
      yield* plane
        .publish(main, job.makeBound(meta('run-b'), { n: 1 }))
        .pipe(Effect.timeoutFail({ duration: '50 millis', onTimeout: () => 'run B blocked' }));
      yield* Effect.promise(() => sleep(20));
      const seenWhileHeld = [...seen];

      holdA.open();
      yield* Fiber.join(blockedA);
      yield* Effect.promise(() => sleep(20));
      return { aBlocked, seenWhileHeld };
    });

    const { aBlocked, seenWhileHeld } = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(aBlocked).toBe(true);
    expect(seenWhileHeld).toEqual(['run-a:job:1', 'run-b:job:1']);
    expect(seen.filter((s) => s.startsWith('run-a'))).toEqual([
      'run-a:job:1',
      'run-a:job:2',
      'run-a:tick:3',
      'run-a:job:3',
    ]);
  });

  test('ending a run drops its queued events and frees publishers waiting for room', async () => {
    const seen: number[] = [];
    // Slow tracing keeps the aborted invocation busy: only dropping the queue frees publishers.
    const tracer: NetworkTracer = {
      onRunStart: async () => {},
      onRunEnd: async () => {},
      onEventPublish: async () => {},
      onAgentInvokeStart: async ({ trigger }) => noopRunTraceScope(trigger.meta),
      onAgentInvokeEnd: () => sleep(300),
      flush: async () => {},
    };
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent }) => {
        registerAgent(
          AgentFactory.run()
            .listensTo([job])
            .logic(async ({ triggerEvent, signal }) => {
              seen.push(triggerEvent.payload.n);
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
            })
            .produce({}),
        ).subscribe(mainChannel);
      },
      { networkTracer: tracer },
    );

    const program = Effect.gen(function* () {
      const plane = yield* network.run({ capacity: 1 });
      yield* plane.publish(main, job.makeBound(meta('run-a'), { n: 1 }));
      yield* Effect.promise(() => sleep(10));
      yield* plane.publish(main, job.makeBound(meta('run-a'), { n: 2 }));
      const blocked = yield* Effect.fork(
        plane.publish(main, job.makeBound(meta('run-a'), { n: 3 })),
      );
      yield* Effect.promise(() => sleep(10));
      const wasBlocked = blocked.unsafePoll() === null;

      const ending = yield* Effect.fork(
        plane.endRun(meta('run-a'), { status: 'cancelled', payload: { reason: 'client-abort' } }),
      );
      yield* Fiber.join(blocked).pipe(
        Effect.timeoutFail({ duration: '100 millis', onTimeout: () => 'publisher still blocked' }),
      );
      yield* Fiber.join(ending);
      return { wasBlocked, stats: inspectEventPlane(plane) };
    });

    const { wasBlocked, stats } = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(wasBlocked).toBe(true);
    expect(seen).toEqual([1]);
    expect(stats).toMatchObject({ activeRuns: 0, mailboxes: 0, outboxes: 0, pendingEvents: 0 });
  });

  test('an agent on two channels has one ordered inbox per run, without duplicates', async () => {
    const tracker = inFlightTracker();
    const seen: number[] = [];
    const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent }) => {
      const sideChannel = createChannel('side');
      registerAgent(
        AgentFactory.run()
          .listensTo([job])
          .logic(async ({ triggerEvent }) => {
            tracker.enter(triggerEvent.meta.runId);
            await sleep(12 - 3 * triggerEvent.payload.n);
            seen.push(triggerEvent.payload.n);
            tracker.leave(triggerEvent.meta.runId);
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .subscribe(sideChannel);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      const channels = network.getChannels();
      const both = [channels.get(main), channels.get(side)].filter((c) => c !== undefined);
      yield* plane.publish(main, job.makeBound(meta('run-1'), { n: 0 }));
      yield* plane.publish(side, job.makeBound(meta('run-1'), { n: 1 }));
      yield* plane.publishToChannels(both, job.makeBound(meta('run-1'), { n: 2 }));
      yield* plane.publish(side, job.makeBound(meta('run-1'), { n: 3 }));
      // A duplicate of n: 2 would sit next to it in the run's ordered inbox, so it shows up within
      // the first four.
      yield* Effect.promise(() => until(() => seen.length >= 4));
    });

    await Effect.runPromise(program.pipe(Effect.scoped));

    expect(seen).toEqual([0, 1, 2, 3]);
    expect(tracker.maxFor('run-1')).toBe(1);
  });

  test('emits keep their order on network.run() with a slow, variable-latency tracer', async () => {
    const request = AgentNetworkEvent.of('request', S.Struct({ n: S.Number }));
    const reply = AgentNetworkEvent.of('reply', S.Struct({ n: S.Number }));
    // Earlier events take longer to trace: any out-of-band publish overtakes them.
    const delays: Record<string, number> = { 'done:1': 30, 'done:2': 20, 'request:3': 0 };
    const tracer: NetworkTracer = {
      onRunStart: async () => {},
      onRunEnd: async () => {},
      onEventPublish: async ({ name, payload }) => {
        await sleep(delays[`${name}:${(payload as { n: number }).n}`] ?? 0);
      },
      onAgentInvokeStart: async ({ trigger }) => noopRunTraceScope(trigger.meta),
      onAgentInvokeEnd: async () => {},
      flush: async () => {},
    };
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent }) => {
        const out = createChannel('client');
        const work = createChannel('work');
        registerAgent(
          AgentFactory.run()
            .listensTo([job])
            .emits([done, request])
            .logic(async ({ emit, emitAndAwait }) => {
              emit(done.make({ n: 1 }));
              emit(done.make({ n: 2 }));
              await emitAndAwait(request.make({ n: 3 }), (e) => e.name === 'reply');
              emit(done.make({ n: 4 }));
            })
            .produce({}),
        )
          .subscribe(mainChannel)
          .publishTo(out)
          .publishTo(work);
        registerAgent(
          AgentFactory.run()
            .listensTo([request])
            .emits([reply], { reply: true })
            .logic(async ({ emit }) => emit(reply.make({ n: 0 })))
            .produce({}),
        )
          .subscribe(work)
          .publishTo(work);
      },
      { networkTracer: tracer },
    );

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      const out = yield* plane.subscribe(client);
      yield* plane.publish(main, job.makeBound(meta('run-1'), { n: 0 }));
      const received: Envelope[] = [];
      for (let i = 0; i < 4; i++) received.push(yield* Queue.take(out));
      return received;
    });

    const received = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(received.map((e) => `${e.name}:${(e.payload as { n: number }).n}`)).toEqual([
      'done:1',
      'done:2',
      'request:3',
      'done:4',
    ]);
  });

  test('a reply queued behind a full mailbox of the awaiting agent still arrives promptly', async () => {
    const request = AgentNetworkEvent.of('request', S.Struct({ n: S.Number }));
    const reply = AgentNetworkEvent.of('reply', S.Struct({ n: S.Number }));
    const seen: number[] = [];
    let waitedMs: number | undefined;
    const network = AgentNetwork.setup(({ mainChannel, registerAgent }) => {
      // X asks Y and waits; Y first floods X's mailbox with jobs (the run's outbox delivers
      // them in order), then replies. The reply must not wait for X's mailbox to drain.
      registerAgent(
        AgentFactory.run()
          .listensTo([job])
          .emits([request])
          .logic(async ({ triggerEvent, emitAndAwait }) => {
            seen.push(triggerEvent.payload.n);
            if (triggerEvent.payload.n !== 0) return;
            const startedAt = Date.now();
            await emitAndAwait(request.make({ n: 0 }), (e) => e.name === 'reply', {
              timeout: '3 seconds',
            });
            waitedMs = Date.now() - startedAt;
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(mainChannel);
      registerAgent(
        AgentFactory.run()
          .listensTo([request])
          .emits([job])
          .emits([reply], { reply: true })
          .logic(async ({ emit }) => {
            for (let n = 1; n <= 5; n++) emit(job.make({ n }));
            emit(reply.make({ n: 0 }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(mainChannel);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run({ capacity: 2 });
      yield* plane.publish(main, job.makeBound(meta('run-1'), { n: 0 }));
      yield* Effect.promise(() => until(() => seen.length >= 6));
    });

    await Effect.runPromise(program.pipe(Effect.scoped));

    expect(waitedMs).toBeDefined();
    // Well before the 3 s timeout a reply stuck behind the full mailbox would run into (with room
    // for a loaded CI machine).
    expect(waitedMs).toBeLessThan(2_000);
    // The jobs that overflowed X's mailbox were not lost, and kept their order.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("agent fibers keep the network's Effect context when an outside caller publishes", async () => {
    const spans: string[] = [];
    const base = Effect.runSync(Effect.tracer);
    const recordingTracer = Tracer.make({
      span: (name, parent, context, links, startTime, kind) => {
        spans.push(name);
        return base.span(name, parent, context, links, startTime, kind);
      },
      context: (f) => f(),
    });
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent }) => {
        registerAgent(
          AgentFactory.run()
            .listensTo([job])
            .logic(async () => {})
            .produce({}),
        ).subscribe(mainChannel);
      },
      { tracingLayer: Layer.setTracer(recordingTracer) },
    );

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      // Published from a plain promise, outside the network's tracing layer.
      yield* Effect.promise(() =>
        Effect.runPromise(plane.publish(main, job.makeBound(meta('run-1'), { n: 1 }))),
      );
      yield* Effect.promise(() => sleep(20));
    });

    await Effect.runPromise(program.pipe(Effect.scoped));

    expect(spans).toEqual(expect.arrayContaining(['agent.listen', 'agent.invoke']));
  });

  test('ended runs release their per-run state on a shared plane', async () => {
    const network = AgentNetwork.setup(({ mainChannel, createChannel, registerAgent, endsOn }) => {
      const out = createChannel('client');
      registerAgent(
        AgentFactory.run()
          .listensTo([job])
          .emits([done])
          .logic(async ({ triggerEvent, emit }) => {
            await sleep(5);
            emit(done.make({ n: triggerEvent.payload.n }));
          })
          .produce({}),
      )
        .subscribe(mainChannel)
        .publishTo(out);
      endsOn(done);
    });

    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      for (let n = 0; n < 10; n++) {
        yield* plane.publish(main, job.makeBound(meta(`run-${n}`), { n }));
      }
      const during = inspectEventPlane(plane);
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, n) => `run-${n}`),
        (runId) => plane.awaitRunEnd(runId),
        { concurrency: 'unbounded' },
      );
      yield* Effect.promise(() => sleep(10));
      return { during, after: inspectEventPlane(plane), outcome: plane.getRunOutcome('run-3') };
    });

    const { during, after, outcome } = await Effect.runPromise(program.pipe(Effect.scoped));

    expect(during.activeRuns).toBe(10);
    expect(after).toMatchObject({ activeRuns: 0, mailboxes: 0, outboxes: 0, pendingEvents: 0 });
    expect(after.rememberedRuns).toBe(10);
    // Recently ended runs are still known, so late events for them are dropped.
    expect(outcome?.status).toBe('completed');
  });
});

describe('event plane concurrency types', () => {
  test('.concurrency() keeps the factory type and takes a number', () => {
    const factory = AgentFactory.run().listensTo([job]).emits([done]);
    expectTypeOf(factory.concurrency(4)).toEqualTypeOf(factory);
    expectTypeOf(factory.concurrency).parameters.toEqualTypeOf<[limit: number]>();
  });

  test('.concurrency() rejects anything but a positive integer or Infinity', () => {
    const factory = AgentFactory.run();
    expect(() => factory.concurrency(0)).toThrow(/positive integer/);
    expect(() => factory.concurrency(1.5)).toThrow(/positive integer/);
    expect(() => factory.concurrency(Number.NaN)).toThrow(/positive integer/);
    expect(factory.concurrency(Infinity)).toBeInstanceOf(AgentFactory);
  });

  test('transient flag on event definitions defaults to false', () => {
    expect(job.transient).toBe(false);
    expect(tick.transient).toBe(true);
    expectTypeOf(tick.transient).toEqualTypeOf<boolean>();
    expectTypeOf(tick).toEqualTypeOf<
      AgentNetworkEventDef<'tick', S.Struct<{ n: typeof S.Number }>>
    >();
    expectTypeOf<Parameters<typeof AgentNetworkEvent.of>[2]>().toEqualTypeOf<
      { transient?: boolean } | undefined
    >();
  });
});
