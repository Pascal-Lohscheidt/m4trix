/**
 * What the network store holds: every durable event is appended as a deep-frozen JSON copy, its
 * payload encoded with its event's schema; folds decode it again on read, skipping (and
 * reporting) what no longer decodes.
 */
import { Chunk, Effect, Either, ParseResult, Queue, Schema as S, type Scope } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import * as root from '../../index.js';
import { AgentFactory } from '../agent-factory.js';
import { ContextFold } from '../context/context-fold.js';
import { isFoldCheckpointEvent } from '../context/fold-checkpoint.js';
import { SegmentedFold } from '../context/segmented-fold.js';
import { ChannelName } from '../identifiers/channel-name.js';
import * as matrix from '../index.js';
import type { NetworkMetric } from '../metrics.js';
import { EmitValidationError } from '../validation.js';
import { AgentNetwork, type AgentNetworkSetupOptions, type AnyAgent } from './agent-network.js';
import { AgentNetworkEvent, type EventMeta } from './agent-network-event.js';
import { type EventPlane, inspectEventPlane, wireEnvelope } from './event-plane.js';
import {
  type ReservedEventNameError,
  RunLifecycleEvent,
  type RunOutcome,
} from './run-lifecycle.js';
import { NonJsonPayloadError } from './stored-payload.js';
import type { AgentNetworkStore, StoredEvent } from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

const Start = AgentNetworkEvent.of('start', S.Struct({ text: S.String }));
/** Transforms: stored as `{ n: '2', at: '2026-…Z' }`. */
const Measured = AgentNetworkEvent.of('measured', S.Struct({ n: S.NumberFromString, at: S.Date }));
const Listed = AgentNetworkEvent.of('listed', S.Struct({ items: S.Array(S.String) }));
const Done = AgentNetworkEvent.of('done', S.Struct({}));

const main = ChannelName('main');
const key = { namespace: 'anonymous', contextId: 'ctx-1' };
const meta = (runId: string): EventMeta => ({ runId, contextId: 'ctx-1' });
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

const quietLogger = () => ({ warn: vi.fn(), error: vi.fn() });

/** Every object of `value` is frozen. */
const deepFrozen = (value: unknown): boolean =>
  typeof value !== 'object' ||
  value === null ||
  (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

/** A network of `agents`, each on main; runs end on `done`. */
function networkOf(agents: AnyAgent[], options: AgentNetworkSetupOptions = {}) {
  return AgentNetwork.setup(
    ({ mainChannel, registerAgent, endsOn }) => {
      for (const agent of agents)
        registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
      endsOn(Done);
    },
    { logger: quietLogger(), wiring: { ignore: ['unconsumed-event'] }, ...options },
  );
}

/** Waits until the run ended and its run-end event is stored. */
const settled = (plane: EventPlane, runId: string) =>
  Effect.gen(function* () {
    const outcome = yield* plane.awaitRunEnd(runId);
    while (inspectEventPlane(plane).activeRuns > 0) yield* Effect.sleep('1 millis');
    return outcome;
  });

/** Publishes `start` in `runId`; resolves with the run's outcome once it ended. */
const startRun = (plane: EventPlane, runId: string, text = 'go') =>
  Effect.gen(function* () {
    yield* plane.publish(main, Start.makeBound(meta(runId), { text }));
    return yield* settled(plane, runId);
  });

const runOnce = (network: AgentNetwork, runId = 'run-1') =>
  Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* network.run();
      return yield* startRun(plane, runId);
    }).pipe(Effect.scoped),
  );

const storedOf = async (store: AgentNetworkStore, name: string, runId = 'run-1') =>
  (await store.readRun(key, runId)).filter((event) => event.name === name);

describe('encode on append: the store gets a frozen JSON copy, encoded with the event schema', () => {
  test("an agent's emit is stored encoded, deep-frozen, sharing nothing with the live event", async () => {
    const store = createInMemoryNetworkStore();
    let emitted: { n: number; at: Date } | undefined;
    let received: unknown;
    const measurer = AgentFactory.run()
      .listensTo([Start])
      .emits([Measured])
      .logic(async ({ emit }) => {
        emitted = { n: 2, at: day(1) };
        emit({ name: 'measured', payload: emitted });
      })
      .produce({});
    const receiver = AgentFactory.run()
      .listensTo([Measured])
      .emits([Done])
      .logic(async ({ triggerEvent, emit }) => {
        received = triggerEvent.payload;
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([measurer, receiver], { store }));

    const [stored] = await storedOf(store, 'measured');
    expect(stored?.payload).toEqual({ n: '2', at: '2026-01-01T00:00:00.000Z' });
    expect(deepFrozen(stored)).toBe(true);
    // Agents get the decoded payload, the very object the emitter made.
    expect(received).toBe(emitted);
    expect(Object.isFrozen(received)).toBe(false);
  });

  test("an emit is encoded with the emitter's own definition, not the network's first one", async () => {
    const store = createInMemoryNetworkStore();
    // Declared first (by the channel) with a schema that keeps the number as it is...
    const CountNumber = AgentNetworkEvent.of('count', S.Struct({ n: S.Number }));
    // ...and emitted by the agent with its own definition, which encodes it as a string: no
    // toJSON gives one for the other.
    const CountString = AgentNetworkEvent.of('count', S.Struct({ n: S.NumberFromString }));
    const counter = AgentFactory.run()
      .listensTo([Start])
      .emits([CountString, Done])
      .logic(async ({ emit }) => {
        emit({ name: 'count', payload: { n: 2 } });
        emit(Done.make({}));
      })
      .produce({});
    const network = AgentNetwork.setup(
      ({ mainChannel, registerAgent, endsOn }) => {
        mainChannel.events([CountNumber, Start, Done]);
        registerAgent(counter).subscribe(mainChannel).publishTo(mainChannel);
        endsOn(Done);
      },
      { store, logger: quietLogger(), wiring: { ignore: ['unconsumed-event'] } },
    );

    const outcome = await runOnce(network);

    expect(outcome.status).toBe('completed');
    expect((await storedOf(store, 'count'))[0]?.payload).toEqual({ n: '2' });
  });

  test('the payload is captured when emitted: changing it afterwards changes nothing stored', async () => {
    const store = createInMemoryNetworkStore();
    const lister = AgentFactory.run()
      .listensTo([Start])
      .emits([Listed, Done])
      .logic(async ({ emit }) => {
        const items = ['a'];
        emit({ name: 'listed', payload: { items } });
        items.push('changed after emit');
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([lister], { store }));

    const [stored] = await storedOf(store, 'listed');
    expect(stored?.payload).toEqual({ items: ['a'] });
  });

  test('an agent that writes to its trigger changes neither the history nor a fold', async () => {
    const store = createInMemoryNetworkStore();
    const Items = ContextFold.of('items')
      .initial((): readonly string[] => [])
      .on(Listed, (all, { payload }) => [...all, ...payload.items]);
    let read: unknown;
    const lister = AgentFactory.run()
      .listensTo([Start])
      .emits([Listed])
      .logic(async ({ emit }) => emit(Listed.make({ items: ['a'] })))
      .produce({});
    const vandal = AgentFactory.run()
      .listensTo([Listed])
      .emits([Done])
      .folds([Items])
      .logic(async ({ triggerEvent, folds, emit }) => {
        (triggerEvent.payload.items as string[]).push('vandalized');
        read = await folds.items();
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([lister, vandal], { store }));

    expect(read).toEqual(['a']);
    expect((await storedOf(store, 'listed'))[0]?.payload).toEqual({ items: ['a'] });
  });

  test('history events are frozen: writing to them throws', async () => {
    const store = createInMemoryNetworkStore();
    let events: readonly StoredEvent[] = [];
    const agent = AgentFactory.run()
      .listensTo([Start])
      .emits([Done])
      .logic(async ({ history, emit }) => {
        events = await history.run();
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([agent], { store }));

    const [start] = events;
    expect(start?.payload).toEqual({ text: 'go' });
    expect(() => {
      (start?.payload as { text: string }).text = 'rewritten';
    }).toThrow(TypeError);
    expect((await store.readRun(key, 'run-1')).every(deepFrozen)).toBe(true);
  });

  test('a published event of a channel: a value of its type is encoded, an encoded one kept', async () => {
    const store = createInMemoryNetworkStore();
    // Only the channel declares Measured: no agent or fold mentions it.
    const network = AgentNetwork.setup(
      ({ createChannel }) => {
        createChannel('metrics').events([Measured]);
      },
      { store, logger: quietLogger(), wiring: { ignore: ['unconsumed-event'] } },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const channel = ChannelName('metrics');
        yield* plane.publish(channel, {
          name: 'measured',
          meta: meta('run-1'),
          payload: { n: 1, at: day(1) },
        });
        // Already in its encoded form, as a client or a proxy sends it.
        yield* plane.publish(channel, {
          name: 'measured',
          meta: meta('run-1'),
          payload: { n: '2', at: '2026-01-02T00:00:00.000Z' },
        });
      }).pipe(Effect.scoped),
    );

    expect((await storedOf(store, 'measured')).map((event) => event.payload)).toEqual([
      { n: '1', at: '2026-01-01T00:00:00.000Z' },
      { n: '2', at: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  test("an event only a fold handles is encoded with the fold's event schema too", async () => {
    const store = createInMemoryNetworkStore();
    const Days = ContextFold.of('days')
      .initial((): readonly number[] => [])
      .on(Measured, (days, { payload }) => [...days, payload.at.getUTCDate()]);
    const reader = AgentFactory.run()
      .listensTo([Start])
      .folds([Days])
      .logic(async () => {})
      .produce({});
    const network = networkOf([reader], { store });

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* plane.publish(main, {
          name: 'measured',
          meta: meta('run-1'),
          payload: { n: 1, at: day(1) },
        });
        yield* plane.publish(main, {
          name: 'measured',
          meta: meta('run-1'),
          payload: { n: '2', at: '2026-01-02T00:00:00.000Z' },
        });
      }).pipe(Effect.scoped),
    );

    expect((await storedOf(store, 'measured')).map((event) => event.payload)).toEqual([
      { n: '1', at: '2026-01-01T00:00:00.000Z' },
      { n: '2', at: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  test('a hand-written agent (no declared emits): known events encoded, unknown ones copied', async () => {
    const store = createInMemoryNetworkStore();
    // Implements only what AnyAgent requires: no emits, listened events or folds declared.
    const custom = (events: ReadonlyArray<{ name: string; payload: unknown }>): AnyAgent => ({
      getId: () => 'custom-agent',
      invoke: async ({ emit }: { emit: (event: { name: string; payload: unknown }) => void }) => {
        for (const event of events) emit(event);
      },
    });
    const networkWith = (agent: AnyAgent, declare: boolean) =>
      AgentNetwork.setup(
        ({ mainChannel, registerAgent, endsOn }) => {
          // Measured is known through the channel only.
          if (declare) mainChannel.events([Start, Measured, Done]);
          registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
          endsOn(Done);
        },
        { store, logger: quietLogger(), wiring: { ignore: ['unconsumed-event'] } },
      );
    const done = Done.make({});

    await runOnce(
      networkWith(custom([{ name: 'measured', payload: { n: 4, at: day(4) } }, done]), true),
      'run-1',
    );
    await runOnce(
      networkWith(
        custom([{ name: 'note', payload: { text: 'free', gone: undefined } }, done]),
        false,
      ),
      'run-2',
    );

    expect((await storedOf(store, 'measured', 'run-1'))[0]?.payload).toEqual({
      n: '4',
      at: '2026-01-04T00:00:00.000Z',
    });
    expect((await storedOf(store, 'note', 'run-2'))[0]?.payload).toEqual({ text: 'free' });
  });

  test('an event without a known schema is stored as a JSON copy of its payload', async () => {
    const store = createInMemoryNetworkStore();
    const network = networkOf([], { store });
    const payload = { a: 1, gone: undefined, list: [{ b: 'x' }] };

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* plane.publish(main, { name: 'request', meta: meta('run-1'), payload });
      }).pipe(Effect.scoped),
    );

    const [stored] = await storedOf(store, 'request');
    expect(stored?.payload).toEqual({ a: 1, list: [{ b: 'x' }] });
    expect(Object.keys(stored?.payload as object)).toEqual(['a', 'list']);
    expect(stored?.payload).not.toBe(payload);
    expect(deepFrozen(stored)).toBe(true);
  });

  test('runtime events are frozen copies; a checkpoint keeps the state as the fold encoded it', async () => {
    const store = createInMemoryNetworkStore();
    const Since = ContextFold.of('since', { state: S.Struct({ first: S.Date, count: S.Number }) })
      .initial(() => ({ first: day(1), count: 0 }))
      .on(Start, (state) => ({ ...state, count: state.count + 1 }));
    let afterCompaction: unknown;
    const compactor = AgentFactory.run()
      .listensTo([Start])
      .emits([Done])
      .folds([Since])
      .logic(async ({ folds, emit }) => {
        afterCompaction = await folds.since.compact((state) => ({ ...state, first: day(9) }));
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([compactor], { store }));

    const events = await store.readRun(key, 'run-1');
    const checkpoint = events.find(isFoldCheckpointEvent);
    expect(checkpoint?.payload.state).toEqual({ first: '2026-01-09T00:00:00.000Z', count: 1 });
    expect(afterCompaction).toEqual({ first: day(9), count: 1 });
    expect(Object.isFrozen(afterCompaction)).toBe(true);
    const completed = events.find((event) => event.name === RunLifecycleEvent.completed);
    expect(completed).toBeDefined();
    expect(events.every(deepFrozen)).toBe(true);
  });
});

describe('a payload that cannot be stored', () => {
  /** Decodes any number, but encodes only up to 100. */
  const Capped = S.transformOrFail(S.String, S.Number, {
    strict: true,
    decode: (text) => ParseResult.succeed(Number(text)),
    encode: (n, _options, ast) =>
      n > 100
        ? ParseResult.fail(new ParseResult.Type(ast, n, 'too large to encode'))
        : ParseResult.succeed(String(n)),
  });
  const Sized = AgentNetworkEvent.of('sized', S.Struct({ size: Capped }));
  const Stamped = AgentNetworkEvent.of('stamped', S.Struct({ at: S.DateFromSelf }));
  const ToolUsed = AgentNetworkEvent.of('tool-used', S.Struct({ output: S.optional(S.Unknown) }));
  const Anything = AgentNetworkEvent.of('anything', S.Unknown);
  const Ticked = AgentNetworkEvent.of('ticked', S.Struct({ at: S.DateFromSelf }), {
    transient: true,
  });

  /** One agent emitting `emitted()` on start; resolves with what it caught and the outcome. */
  const emitting = async (emitted: () => { name: string; payload: unknown }) => {
    const store = createInMemoryNetworkStore();
    let caught: unknown;
    const agent = AgentFactory.run()
      .listensTo([Start])
      .emits([Sized, Stamped, ToolUsed, Anything])
      .logic(async ({ emit }) => {
        try {
          emit(emitted() as never);
        } catch (error) {
          caught = error;
        }
      })
      .produce({});
    const outcome = await runOnce(networkOf([agent], { store }));
    return { caught, outcome, store, agentId: agent.getId() };
  };

  const failure = (outcome: RunOutcome) =>
    outcome.status === 'failed' ? outcome.payload.error : undefined;

  test('an emit its schema cannot encode throws EmitValidationError and fails the run', async () => {
    const { caught, outcome, store, agentId } = await emitting(() => ({
      name: 'sized',
      payload: { size: 1000 },
    }));

    expect(caught).toBeInstanceOf(EmitValidationError);
    expect(caught).toMatchObject({
      eventName: 'sized',
      agentId,
      reason: 'invalid-payload',
      issues: [{ path: 'size', message: expect.stringContaining('too large to encode') }],
    });
    expect(failure(outcome)).toMatchObject({ kind: 'invalid-emit', event: 'sized' });
    expect(await storedOf(store, 'sized')).toEqual([]);
  });

  test('an emit whose encoded payload is not JSON throws the same way, naming the path', async () => {
    const { caught, outcome, store, agentId } = await emitting(() => ({
      name: 'stamped',
      payload: { at: day(1) },
    }));

    // Its own wording: the payload matches its schema, JSON cannot hold it.
    expect((caught as Error).message).toBe(
      `Agent "${agentId}" emitted "stamped" with a payload that is not JSON-compatible: a Date ` +
        'at at (events are stored as JSON, encoded with their schema)',
    );
    expect(caught).toMatchObject({
      eventName: 'stamped',
      reason: 'invalid-payload',
      issues: [
        {
          path: 'at',
          message:
            'a Date is not JSON-compatible: events are stored as JSON, encoded with their ' +
            'schema; give it a schema that encodes it (e.g. S.Date, not S.DateFromSelf)',
        },
      ],
    });
    expect(failure(outcome)).toMatchObject({ kind: 'invalid-emit', event: 'stamped' });
    expect(await storedOf(store, 'stamped')).toEqual([]);
  });

  test('a value JSON cannot hold inside an S.Unknown field: the wording names it and its path', async () => {
    const { caught, outcome } = await emitting(() => ({
      name: 'tool-used',
      payload: { output: [{ id: 1, error: new Error('lost') }] },
    }));

    expect(caught).toMatchObject({
      reason: 'invalid-payload',
      issues: [{ path: 'output[0].error', message: expect.stringMatching(/^an Error is not/) }],
    });
    expect((caught as Error).message).toContain(
      'with a payload that is not JSON-compatible: an Error at output[0].error',
    );
    expect(failure(outcome)).toMatchObject({
      kind: 'invalid-emit',
      message: expect.stringContaining('not JSON-compatible: an Error at output[0].error'),
    });
    const { caught: atRoot } = await emitting(() => ({ name: 'anything', payload: new Map() }));
    expect((atRoot as Error).message).toContain('not JSON-compatible: a Map at (root)');
    const { caught: getter } = await emitting(() => ({
      name: 'tool-used',
      payload: {
        output: {
          get rows(): never {
            throw new Error('getter failed');
          },
        },
      },
    }));
    expect(getter).toBeInstanceOf(EmitValidationError);
    expect((getter as Error).message).toContain(
      'not JSON-compatible: a getter that threw at output.rows',
    );
  });

  /** An agent that emits `payloads` on start, then done; resolves with what was stored. */
  const emittingAll = async (payloads: ReadonlyArray<{ name: string; payload: unknown }>) => {
    const store = createInMemoryNetworkStore();
    const Row = AgentNetworkEvent.of('row', S.Record({ key: S.String, value: S.Unknown }));
    const Stamp = AgentNetworkEvent.of('stamp', S.Struct({ at: S.Date, on: S.DateFromString }));
    const received: unknown[] = [];
    const emitter = AgentFactory.run()
      .listensTo([Start])
      .emits([ToolUsed, Row, Stamp, Done])
      .logic(async ({ emit }) => {
        for (const event of payloads) emit(event as never);
        emit(Done.make({}));
      })
      .produce({});
    const receiver = AgentFactory.run()
      .listensTo([ToolUsed, Row])
      .logic(async ({ triggerEvent }) => {
        received.push(triggerEvent.payload);
      })
      .produce({});
    const outcome = await runOnce(networkOf([emitter, receiver], { store }));
    const stored = (await store.readRun(key, 'run-1'))
      .filter((event) => payloads.some(({ name }) => name === event.name))
      .map((event) => event.payload);
    return { outcome, stored, received };
  };

  test('a Date (any value with a toJSON) in an S.Unknown field is stored as its toJSON', async () => {
    const output = [{ id: 1, createdAt: day(1) }];
    const row = { createdAt: day(2), price: { toJSON: () => '19.99' } };

    const { outcome, stored, received } = await emittingAll([
      { name: 'tool-used', payload: { output } },
      { name: 'row', payload: row },
    ]);

    expect(outcome.status).toBe('completed');
    // What JSON.stringify writes: the ISO string, the Decimal-like value's own form.
    expect(stored).toEqual([
      { output: [{ id: 1, createdAt: '2026-01-01T00:00:00.000Z' }] },
      { createdAt: '2026-01-02T00:00:00.000Z', price: '19.99' },
    ]);
    // Agents get the payload as it was emitted, Dates and all.
    expect(received).toEqual([{ output }, row]);
    expect((received[0] as { output: typeof output }).output[0]?.createdAt).toBeInstanceOf(Date);
  });

  test('a schema whose decoded side is a Date encodes it itself: toJSON is not asked', async () => {
    // A Date whose toJSON says something else: S.Date and S.DateFromString write the ISO string.
    const odd = Object.assign(day(3), { toJSON: () => 'not this' });

    const { outcome, stored } = await emittingAll([
      { name: 'stamp', payload: { at: odd, on: odd } },
    ]);

    expect(outcome.status).toBe('completed');
    expect(stored).toEqual([{ at: '2026-01-03T00:00:00.000Z', on: '2026-01-03T00:00:00.000Z' }]);
  });

  test('transient events are never stored: they are not checked for JSON', async () => {
    let caught: unknown;
    const delivered: unknown[] = [];
    const ticker = AgentFactory.run()
      .listensTo([Start])
      .emits([Ticked, Done])
      .logic(async ({ emit }) => {
        try {
          emit({ name: 'ticked', payload: { at: day(1) } });
        } catch (error) {
          caught = error;
        }
      })
      .produce({});
    const watcher = AgentFactory.run()
      .listensTo([Ticked])
      .emits([Done])
      .logic(async ({ triggerEvent, emit }) => {
        delivered.push(triggerEvent.payload.at);
        emit(Done.make({}));
      })
      .produce({});

    const outcome = await runOnce(networkOf([ticker, watcher]));

    expect(caught).toBeUndefined();
    expect(delivered).toEqual([day(1)]);
    expect(outcome.status).toBe('completed');
  });
});

describe('a payload published from outside that JSON cannot hold: the publish itself is refused', () => {
  const Note = AgentNetworkEvent.of('note', S.Struct({ data: S.Unknown }));
  const Stamped = AgentNetworkEvent.of('stamped', S.Struct({ at: S.DateFromSelf }));
  /** Records the notes it gets; ends the run on start. */
  const fixture = () => {
    const appended: string[] = [];
    const inner = createInMemoryNetworkStore();
    const store: AgentNetworkStore = {
      ...inner,
      append: (storeKey, event) => {
        appended.push(event.name);
        return inner.append(storeKey, event);
      },
    };
    const logger = quietLogger();
    const notes: unknown[] = [];
    const agent = AgentFactory.run()
      .listensTo([Start, Note, Stamped])
      .emits([Done])
      .logic(async ({ triggerEvent, emit }) => {
        if (triggerEvent.name === 'start') emit(Done.make({}));
        else notes.push(triggerEvent.payload);
      })
      .produce({});
    return { network: networkOf([agent], { store, logger }), appended, logger, notes, store };
  };

  test('NonJsonPayloadError in the error channel: nothing published or stored, the run goes on', async () => {
    const { network, appended, logger, notes, store } = fixture();

    const { refused, outcome } = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const note = (data: unknown) => ({ name: 'note', meta: meta('run-1'), payload: { data } });
        const refused = yield* Effect.either(plane.publish(main, note(new Map())));
        yield* plane.publish(main, note('kept'));
        return { refused, outcome: yield* startRun(plane, 'run-1') };
      }).pipe(Effect.scoped),
    );

    const error = Either.isLeft(refused) ? refused.left : undefined;
    expect(error).toBeInstanceOf(NonJsonPayloadError);
    expect(error).toMatchObject({
      _tag: 'NonJsonPayloadError',
      eventName: 'note',
      path: 'data',
      found: 'a Map',
    });
    expect(error?.message).toBe(
      'Published "note" with a payload that is not JSON-compatible: a Map at data (events are ' +
        'stored as JSON, encoded with their schema); nothing was published',
    );
    // Refused before anything happened: no store write (so no retry), no delivery, no run end.
    expect(outcome.status).toBe('completed');
    expect(notes).toEqual([{ data: 'kept' }]);
    expect(appended.filter((name) => name === 'note')).toHaveLength(1);
    expect((await storedOf(store, 'note')).map((event) => event.payload)).toEqual([
      { data: 'kept' },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('publishToChannels and publishAndAwait refuse it too; so does a payload at the root', async () => {
    const { network, appended } = fixture();

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const channels = [...network.getChannels().values()];
        const note = { name: 'note', meta: meta('run-1'), payload: { data: [1, 2n] } };
        const results: Array<Either.Either<unknown, Error>> = [
          yield* Effect.either(plane.publishToChannels(channels, note)),
          yield* Effect.either(plane.publishAndAwait(channels, note, () => true)),
          yield* Effect.either(
            plane.publish(main, { name: 'free', meta: meta('run-1'), payload: new Set() }),
          ),
        ];
        return results;
      }).pipe(Effect.scoped),
    );

    expect(results.map((result) => Either.isLeft(result) && result.left)).toEqual([
      expect.objectContaining({ _tag: 'NonJsonPayloadError', path: 'data[1]', found: 'a bigint' }),
      expect.objectContaining({ _tag: 'NonJsonPayloadError', path: 'data[1]', found: 'a bigint' }),
      expect.objectContaining({ eventName: 'free', path: '', found: 'a Set' }),
    ]);
    const [, , atRoot] = results;
    expect(atRoot && Either.isLeft(atRoot) && atRoot.left.message).toContain(
      'not JSON-compatible: a Set at (root)',
    );
    expect(appended).toEqual([]);
  });

  test('a Date in an S.Unknown field is stored as its ISO string; one its schema keeps is refused', async () => {
    const { network, notes, store } = fixture();

    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* plane.publish(main, {
          name: 'note',
          meta: meta('run-1'),
          payload: { data: day(1) },
        });
        // S.DateFromSelf: its toJSON (an ISO string) is no Date, so it could never be read back.
        const refused = yield* Effect.either(
          plane.publish(main, { name: 'stamped', meta: meta('run-1'), payload: { at: day(2) } }),
        );
        yield* startRun(plane, 'run-1');
        return refused;
      }).pipe(Effect.scoped),
    );

    expect(Either.isLeft(refused) && refused.left).toMatchObject({
      eventName: 'stamped',
      path: 'at',
      found: 'a Date',
    });
    expect(notes).toEqual([{ data: day(1) }]);
    expect((await storedOf(store, 'note')).map((event) => event.payload)).toEqual([
      { data: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(await storedOf(store, 'stamped')).toEqual([]);
  });

  test('a toJSON or a getter that throws is refused the same way, by path: no defect', async () => {
    const { network, notes } = fixture();
    const throwing = {
      toJSON(): never {
        throw new Error('toJSON failed');
      },
    };
    const getter = {
      get rows(): never {
        throw new Error('getter failed');
      },
    };

    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const note = (data: unknown) => ({ name: 'note', meta: meta('run-1'), payload: { data } });
        const refused = [
          yield* Effect.either(plane.publish(main, note(throwing))),
          yield* Effect.either(plane.publish(main, note(getter))),
        ];
        yield* startRun(plane, 'run-1');
        return refused;
      }).pipe(Effect.scoped),
    );

    expect(refused.map((result) => Either.isLeft(result) && result.left)).toEqual([
      expect.objectContaining({
        _tag: 'NonJsonPayloadError',
        path: 'data',
        found: 'an object whose toJSON threw',
      }),
      expect.objectContaining({
        _tag: 'NonJsonPayloadError',
        path: 'data.rows',
        found: 'a getter that threw',
      }),
    ]);
    expect(notes).toEqual([]);
  });

  test('a non-finite ts or depth (typed, so JSON cannot hold it) is stamped like a missing one', async () => {
    const { network, store } = fixture();

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const before = Date.now();
        // A finite ts and depth a publisher set are kept, also when the eventId is stamped.
        yield* plane.publish(main, {
          name: 'note',
          meta: { ...meta('run-1'), ts: 5, depth: 0 },
          payload: { data: 'kept' },
        });
        yield* plane.publish(
          main,
          Start.makeBound(
            { ...meta('run-1'), ts: Number.NaN, depth: Number.POSITIVE_INFINITY },
            { text: 'go' },
          ),
        );
        const outcome = yield* settled(plane, 'run-1');
        return { outcome, before };
      }).pipe(Effect.scoped),
    );

    expect(outcome.outcome.status).toBe('completed');
    const [start] = await storedOf(store, 'start');
    expect(start?.meta.depth).toBe(0);
    expect(start?.meta.ts).toBeGreaterThanOrEqual(outcome.before);
    expect((await storedOf(store, 'note'))[0]?.meta).toMatchObject({ ts: 5, depth: 0 });
  });

  test('meta JSON cannot hold (from an untyped caller) still fails its run: store-error', async () => {
    const { network, logger } = fixture();

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* plane.publish(main, {
          name: 'note',
          meta: { ...meta('run-1'), trace: 1n } as EventMeta,
          payload: { data: 'x' },
        });
        return yield* settled(plane, 'run-1');
      }).pipe(Effect.scoped),
    );

    expect(outcome.status === 'failed' && outcome.payload.error).toMatchObject({
      kind: 'store-error',
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[m4trix] could not store note of run run-1: the value at meta.trace is not ' +
        'JSON-compatible: a bigint',
    );
  });

  test('types: plane.publish fails with ReservedEventNameError or NonJsonPayloadError; exported', () => {
    expectTypeOf<Effect.Effect.Error<ReturnType<EventPlane['publish']>>>().toEqualTypeOf<
      ReservedEventNameError | NonJsonPayloadError
    >();
    expectTypeOf<NonJsonPayloadError['found']>().toEqualTypeOf<string>();
    for (const entry of [root, matrix]) expect(entry.NonJsonPayloadError).toBe(NonJsonPayloadError);
  });
});

describe('the wire fails closed for secrets', () => {
  test('a transient event holding S.Redacted that its schema cannot encode is sent as "<redacted>"', async () => {
    const Tick = AgentNetworkEvent.of(
      'tick',
      S.Struct({ token: S.Redacted(S.String), n: S.Number }),
      { transient: true },
    );
    const agent = AgentFactory.run()
      .listensTo([Start, Tick])
      .emits([Done])
      .logic(async ({ triggerEvent, emit }) => {
        if (triggerEvent.name === 'start') emit(Done.make({}));
      })
      .produce({});
    const network = networkOf([agent]);

    const sent = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const queue = yield* plane.subscribe(main);
        // From outside, unchecked: a plain string where a Redacted value belongs.
        yield* plane.publish(main, {
          name: 'tick',
          meta: meta('run-1'),
          payload: { token: 'hunter2', n: 1 },
        });
        yield* startRun(plane, 'run-1');
        const events = Chunk.toReadonlyArray(yield* Queue.takeAll(queue));
        return events
          .filter((event) => event.name === 'tick')
          .map((event) => wireEnvelope(plane, event));
      }).pipe(Effect.scoped),
    );

    // The whole payload: which part held the secret is unknown once encoding failed.
    expect(sent.map((event) => event.payload)).toEqual(['<redacted>']);
    expect(sent[0]?.meta.runId).toBe('run-1');
  });
});

describe('fields a schema does not know: stripped on read, so compaction keeps working', () => {
  const Msg = AgentNetworkEvent.of('msg', S.Struct({ text: S.String }));
  /** Puts payloads into its state as they are: extra fields would reach the checkpoint. */
  const Log = ContextFold.of('log', {
    state: S.Struct({ items: S.Array(S.Struct({ text: S.String })) }),
  })
    .initial(() => ({ items: [] }))
    .on(Msg, (state, { payload }) => ({ items: [...state.items, payload] }));

  /** Reads the log, compacts it to its newest item and reads it again. */
  const compactingReader = (results: unknown[]) =>
    AgentFactory.run()
      .listensTo([Start])
      .emits([Done])
      .folds([Log])
      .logic(async ({ folds, emit }) => {
        results.push(await folds.log());
        results.push(await folds.log.compact((state) => ({ items: state.items.slice(-1) })));
        emit(Done.make({}));
      })
      .produce({});

  test('an outside publish with an extra field folds without it, and the fold compacts', async () => {
    const results: unknown[] = [];
    const network = networkOf([compactingReader(results)]);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        // As server code relays JSON it received; the schema has no `legacy` field.
        yield* plane.publish(main, {
          name: 'msg',
          meta: meta('run-1'),
          payload: { text: 'a', legacy: true },
        });
        return yield* startRun(plane, 'run-1');
      }).pipe(Effect.scoped),
    );

    expect(outcome.status).toBe('completed');
    expect(results).toEqual([{ items: [{ text: 'a' }] }, { items: [{ text: 'a' }] }]);
  });

  test('an event stored before a field was removed from its schema still folds, without it', async () => {
    const store = createInMemoryNetworkStore();
    await store.append(key, {
      name: 'msg',
      meta: { ...meta('run-0'), eventId: 'old' },
      payload: { text: 'old', removedSince: { deep: [1] } },
    });
    const results: unknown[] = [];

    const outcome = await runOnce(networkOf([compactingReader(results)], { store }));

    expect(outcome.status).toBe('completed');
    expect(results).toEqual([{ items: [{ text: 'old' }] }, { items: [{ text: 'old' }] }]);
  });
});

describe('skip and report: folds leave out what no longer decodes, and the network says so', () => {
  const Days = ContextFold.of('days')
    .initial((): readonly number[] => [])
    .on(Measured, (days, { payload }) => [...days, payload.at.getUTCDate()]);

  /** A store holding a measurement from before its schema changed, and a valid one. */
  const legacyStore = async () => {
    const store = createInMemoryNetworkStore();
    await store.append(key, {
      name: 'measured',
      meta: { ...meta('run-0'), eventId: 'legacy-1' },
      payload: { value: 3 },
    });
    await store.append(key, {
      name: 'measured',
      meta: { ...meta('run-0'), eventId: 'valid-1' },
      payload: { n: '1', at: '2026-01-05T00:00:00.000Z' },
    });
    return store;
  };

  /** Reads `Days` on every start; `reads` collects the states. */
  const readingNetwork = (options: AgentNetworkSetupOptions) => {
    const reads: unknown[] = [];
    const reader = AgentFactory.run()
      .listensTo([Start])
      .emits([Done])
      .folds([Days])
      .logic(async ({ folds, emit }) => {
        reads.push(await folds.days());
        emit(Done.make({}));
      })
      .produce({});
    return { network: networkOf([reader], options), reads };
  };

  test('an undecodable event is skipped; logger.warn and m4trix.fold.read.skipped report it once per plane', async () => {
    let now = 0;
    const store = await legacyStore();
    const logger = quietLogger();
    const metrics: NetworkMetric[] = [];
    const { network, reads } = readingNetwork({
      store,
      logger,
      onMetric: (metric) => metrics.push(metric),
      // Every read is cold: the cached state expires in between.
      foldCache: { ttl: '1 minute', clock: { unsafeCurrentTimeMillis: () => now } },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        yield* startRun(plane, 'run-1');
        now += 120_000;
        yield* startRun(plane, 'run-2');
      }).pipe(Effect.scoped),
    );
    // Another plane (e.g. after a restart) reports it again.
    await runOnce(network, 'run-3');

    expect(reads).toEqual([[5], [5], [5]]);
    const skipped = metrics.filter((metric) => metric.name === 'm4trix.fold.read.skipped');
    expect(skipped).toEqual([
      {
        name: 'm4trix.fold.read.skipped',
        kind: 'counter',
        unit: '{event}',
        value: 1,
        attributes: { fold: 'days', reason: 'decode' },
      },
      expect.objectContaining({ attributes: { fold: 'days', reason: 'decode' } }),
    ]);
    const warnings = logger.warn.mock.calls.filter(([message]) =>
      String(message).includes('skipped'),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toEqual([
      expect.stringContaining(
        '[m4trix] fold "days": skipped measured "legacy-1", its stored payload does not decode ' +
          "with the event's schema",
      ),
      { fold: 'days', reason: 'decode', event: 'measured', eventId: 'legacy-1' },
    ]);
  });

  /** Cold reads of `Days` in contexts `contexts`, in order, on one plane; the skip metrics. */
  const coldReads = async (store: AgentNetworkStore, contexts: readonly string[]) => {
    let now = 0;
    const metrics: NetworkMetric[] = [];
    const { network } = readingNetwork({
      store,
      onMetric: (metric) => metrics.push(metric),
      foldCache: { ttl: '1 minute', clock: { unsafeCurrentTimeMillis: () => now } },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* network.run();
        for (const [index, contextId] of contexts.entries()) {
          now += 120_000;
          yield* plane.publish(
            main,
            Start.makeBound({ runId: `r${index}`, contextId }, { text: '' }),
          );
          yield* settled(plane, `r${index}`);
        }
      }).pipe(Effect.scoped),
    );
    return metrics.filter((metric) => metric.name === 'm4trix.fold.read.skipped').length;
  };
  const legacy = (contextId: string, eventId?: string): StoredEvent => ({
    name: 'measured',
    meta: { runId: 'old', contextId, ...(eventId !== undefined && { eventId }) },
    payload: { value: 3 },
  });

  test('a plane remembers the last 1000 reported skips: an older one is reported again', async () => {
    const store = createInMemoryNetworkStore();
    await store.append({ ...key, contextId: 'a' }, legacy('a', 'a-0'));
    for (let i = 0; i < 1000; i++)
      await store.append({ ...key, contextId: 'b' }, legacy('b', `b-${i}`));

    // a: 1; b: 1000, which pushes a's out; a again: reported once more.
    expect(await coldReads(store, ['a', 'b', 'a'])).toBe(1 + 1000 + 1);
  });

  test('least recently seen first: a skip seen again is kept over older ones', async () => {
    const store = createInMemoryNetworkStore();
    await store.append({ ...key, contextId: 'a' }, legacy('a', 'a-0'));
    for (let i = 0; i < 999; i++)
      await store.append({ ...key, contextId: 'b' }, legacy('b', `b-${i}`));
    await store.append({ ...key, contextId: 'c' }, legacy('c', 'c-0'));

    // a: 1; b: 999 (1000 remembered); a again: seen, not reported, now the most recent; c: 1,
    // which pushes out b-0, the least recently seen; a again: still remembered.
    expect(await coldReads(store, ['a', 'b', 'a', 'c', 'a'])).toBe(1 + 999 + 1);
  });

  test('an event without an id (appended by hand) cannot be told apart: reported on every read', async () => {
    const store = createInMemoryNetworkStore();
    await store.append(key, legacy('ctx-1'));

    expect(await coldReads(store, ['ctx-1', 'ctx-1'])).toBe(2);
  });

  test('a checkpoint that does not restore goes through the same channel (reason checkpoint)', async () => {
    const Log = ContextFold.of('log', { state: S.Array(S.String) })
      .initial(() => [])
      .on(Start, (lines, { payload }) => [...lines, payload.text]);
    const store = createInMemoryNetworkStore();
    await store.append(key, {
      name: 'm4trix:fold.checkpoint:log@1',
      meta: { ...meta('run-0'), eventId: 'bad' },
      payload: { fold: 'log', version: 1, through: null, state: 'not lines' },
    });
    const logger = quietLogger();
    const metrics: NetworkMetric[] = [];
    let read: unknown;
    const reader = AgentFactory.run()
      .listensTo([Start])
      .emits([Done])
      .folds([Log])
      .logic(async ({ folds, emit }) => {
        read = await folds.log();
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([reader], { store, logger, onMetric: (m) => metrics.push(m) }));

    expect(read).toEqual(['go']);
    expect(metrics.filter((metric) => metric.name === 'm4trix.fold.read.skipped')).toEqual([
      expect.objectContaining({ attributes: { fold: 'log', reason: 'checkpoint' } }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[m4trix] fold "log": skipped checkpoint "bad", it does not decode with the fold\'s ' +
          'state schema',
      ),
      { fold: 'log', reason: 'checkpoint', event: 'm4trix:fold.checkpoint:log@1', eventId: 'bad' },
    );
  });

  test("an event attach finds no segment for is reported (reason missing-segment) unless 'ignore'", async () => {
    const Opened = AgentNetworkEvent.of('opened', S.Struct({ id: S.String }));
    const Noted = AgentNetworkEvent.of('noted', S.Struct({ id: S.String, text: S.String }));
    const Quiet = AgentNetworkEvent.of('quiet', S.Struct({ id: S.String }));
    const Loose = AgentNetworkEvent.of('loose', S.Struct({ id: S.String }));
    const Notes = SegmentedFold.of('notes', {
      data: S.Struct({ kind: S.Literal('note'), texts: S.Array(S.String) }),
      tag: 'kind',
    })
      .open(Opened, ({ payload }) => ({ id: payload.id, data: { kind: 'note', texts: [] } }))
      .attach(Noted, {
        kind: 'note',
        to: ({ payload }) => payload.id,
        update: (note, { payload }) => ({ ...note, texts: [...note.texts, payload.text] }),
      })
      .attach(Quiet, { to: ({ payload }) => payload.id, onMissing: 'ignore', update: (d) => d })
      .attach(Loose, { to: ({ payload }) => payload.id, update: (d) => d });
    const store = createInMemoryNetworkStore();
    await store.append(key, Opened.makeBound({ ...meta('run-0'), eventId: 'o1' }, { id: 'a' }));
    await store.append(
      key,
      Noted.makeBound({ ...meta('run-0'), eventId: 'n1' }, { id: 'nowhere', text: 'lost' }),
    );
    await store.append(key, Quiet.makeBound({ ...meta('run-0'), eventId: 'q1' }, { id: 'none' }));
    await store.append(key, Loose.makeBound({ ...meta('run-0'), eventId: 'l1' }, { id: 'x' }));
    const logger = quietLogger();
    const metrics: NetworkMetric[] = [];
    let read: unknown;
    const reader = AgentFactory.run()
      .listensTo([Start])
      .emits([Done])
      .folds([Notes])
      .logic(async ({ folds, emit }) => {
        read = await folds.notes();
        emit(Done.make({}));
      })
      .produce({});

    await runOnce(networkOf([reader], { store, logger, onMetric: (m) => metrics.push(m) }));

    expect(read).toEqual({ segments: [{ id: 'a', data: { kind: 'note', texts: [] } }] });
    expect(metrics.filter((metric) => metric.name === 'm4trix.fold.read.skipped')).toEqual([
      expect.objectContaining({ attributes: { fold: 'notes', reason: 'missing-segment' } }),
      expect.objectContaining({ attributes: { fold: 'notes', reason: 'missing-segment' } }),
    ]);
    // Without a kind, the report names the id only.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[m4trix] fold "notes": loose "l1" attaches to no segment (id "x");'),
      expect.objectContaining({ segment: { id: 'x' } }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[m4trix] fold "notes": noted "n1" attaches to no segment (id "nowhere", kind "note"); ' +
        "the state was left as it was (pass onMissing: 'ignore' to attach() when that is " +
        'expected)',
      {
        fold: 'notes',
        reason: 'missing-segment',
        event: 'noted',
        eventId: 'n1',
        segment: { id: 'nowhere', kind: 'note' },
      },
    );
  });

  test('the metric is typed: fold name and reason', () => {
    type Skipped = Extract<NetworkMetric, { name: 'm4trix.fold.read.skipped' }>;
    expectTypeOf<Skipped['kind']>().toEqualTypeOf<'counter'>();
    expectTypeOf<Skipped['attributes']>().toEqualTypeOf<{
      readonly fold: string;
      readonly reason: 'decode' | 'checkpoint' | 'missing-segment';
    }>();
  });
});

describe('wireEnvelope: an event as it leaves the network', () => {
  const Ticked = AgentNetworkEvent.of('ticked', S.Struct({ n: S.NumberFromString }), {
    transient: true,
  });
  const ticker = AgentFactory.run()
    .listensTo([Start])
    .emits([Ticked])
    .logic(async () => {})
    .produce({});

  const onPlane = <A, E>(use: (plane: EventPlane) => Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* networkOf([ticker]).run());
      }).pipe(Effect.scoped),
    );

  test('an event not stored is encoded with its schema; one without a schema is sent as it is', async () => {
    const tick = { name: 'ticked', meta: meta('run-1'), payload: { n: 3 } };
    const unknown = { name: 'request', meta: meta('run-1'), payload: { at: day(1) } };
    const unencodable = { name: 'ticked', meta: meta('run-1'), payload: { n: 'three' } };

    const [encoded, asIs, asGiven] = await onPlane((plane) =>
      Effect.sync(() => [tick, unknown, unencodable].map((e) => wireEnvelope(plane, e))),
    );

    expect(encoded).toEqual({ ...tick, payload: { n: '3' } });
    expect(asIs).toBe(unknown);
    // A payload its schema cannot encode is sent as it is.
    expect(asGiven).toBe(unencodable);
  });

  test('a stored event is sent as its stored copy, without channels, the same object each time', async () => {
    const [first, second, stored] = await onPlane((plane) =>
      Effect.gen(function* () {
        const queue = yield* plane.subscribe(main);
        yield* plane.publish(main, Start.makeBound(meta('run-1'), { text: 'go' }));
        const live = yield* Queue.take(queue);
        const [copy] = yield* Effect.promise(() => plane.history(meta('run-1')).run());
        return [wireEnvelope(plane, live), wireEnvelope(plane, live), copy] as const;
      }),
    );

    expect(first).toBe(second);
    expect(first).toEqual({ name: 'start', meta: stored?.meta, payload: { text: 'go' } });
    expect(first?.payload).toBe(stored?.payload);
    expect(stored?.channels).toEqual(['main']);
  });
});
