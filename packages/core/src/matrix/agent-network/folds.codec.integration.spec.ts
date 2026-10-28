/**
 * The correctness proof of encode on append / decode on read: a fold over events whose schemas
 * transform (`NumberFromString`, `Date`, `Option`, a class), with a state schema that transforms
 * too, reads the same state whatever the store does with its JSON (kept by reference, or cloned
 * on every write and read, as a database would), warm and cold, across a compaction checkpoint.
 */
import { Effect, Option, Schema as S } from 'effect';
import { describe, expect, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { ContextFold } from '../context/context-fold.js';
import { isFoldCheckpointEvent } from '../context/fold-checkpoint.js';
import { ChannelName } from '../identifiers/channel-name.js';
import { AgentNetwork } from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import { type EventPlane, inspectEventPlane } from './event-plane.js';
import type { AgentNetworkStore } from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

class Parcel extends S.Class<Parcel>('Parcel')({ weight: S.NumberFromString, since: S.Date }) {}

const Order = AgentNetworkEvent.of('order', S.Struct({ item: S.String, cents: S.Number }));
const Priced = AgentNetworkEvent.of(
  'priced',
  S.Struct({ item: S.String, cents: S.NumberFromString, at: S.Date, note: S.Option(S.String) }),
);
const Shipped = AgentNetworkEvent.of('shipped', S.Struct({ item: S.String, parcel: Parcel }));
const Done = AgentNetworkEvent.of('done', S.Struct({}));

const Line = S.Struct({
  item: S.String,
  cents: S.NumberFromString,
  at: S.Date,
  note: S.Option(S.String),
});
const Ledger = ContextFold.of('ledger', {
  state: S.Struct({
    summary: S.Option(S.String),
    lines: S.Array(Line),
    parcels: S.Array(Parcel),
  }),
})
  .initial(() => ({ summary: Option.none(), lines: [], parcels: [] }))
  .on(Priced, (state, { payload }) => ({ ...state, lines: [...state.lines, payload] }))
  .on(Shipped, (state, { payload }) => ({ ...state, parcels: [...state.parcels, payload.parcel] }));

type LedgerState = typeof Ledger extends { initialState(): infer State } ? State : never;

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

/** The in-memory store, or one that JSON-clones every event it writes and every page it reads. */
function storeOf(variant: 'in-memory' | 'json-clone'): AgentNetworkStore {
  const inner = createInMemoryNetworkStore();
  if (variant === 'in-memory') return inner;
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    append: (key, event) => inner.append(key, clone(event)),
    readRun: async (key, runId) => clone(await inner.readRun(key, runId)),
    readContext: async (key, options) => clone(await inner.readContext(key, options)),
    readLatest: async (key, names) =>
      clone(await (inner.readLatest as NonNullable<AgentNetworkStore['readLatest']>)(key, names)),
  };
}

/**
 * clerk: order -> priced, shipped. bookkeeper: shipped -> reads the ledger (warm), compacts it on
 * `compactOn`, then done (ends the run).
 */
function ledgerNetwork(store: AgentNetworkStore, reads: LedgerState[], compactOn?: string) {
  return AgentNetwork.setup(
    ({ mainChannel, registerAgent, endsOn }) => {
      const clerk = AgentFactory.run()
        .listensTo([Order])
        .emits([Priced, Shipped])
        .logic(async ({ triggerEvent, emit }) => {
          const { item, cents } = triggerEvent.payload;
          const n = cents / 100;
          emit({
            name: 'priced',
            payload: {
              item,
              cents,
              at: day(n),
              note: n % 2 === 0 ? Option.some(`even ${item}`) : Option.none(),
            },
          });
          emit({
            name: 'shipped',
            payload: { item, parcel: new Parcel({ weight: n * 1.5, since: day(n + 1) }) },
          });
        })
        .produce({});
      const bookkeeper = AgentFactory.run()
        .listensTo([Shipped])
        .emits([Done])
        .folds([Ledger])
        .logic(async ({ triggerEvent, folds, emit }) => {
          reads.push(await folds.ledger());
          if (triggerEvent.payload.item === compactOn) {
            reads.push(
              await folds.ledger.compact((state) => ({
                summary: Option.some(`${state.lines.length} lines before ${compactOn}`),
                lines: state.lines.slice(-1),
                parcels: state.parcels,
              })),
            );
          }
          emit(Done.make({}));
        })
        .produce({});
      registerAgent(clerk).subscribe(mainChannel).publishTo(mainChannel);
      registerAgent(bookkeeper).subscribe(mainChannel).publishTo(mainChannel);
      endsOn(Done);
    },
    { store, logger: { warn: vi.fn(), error: vi.fn() } },
  );
}

const order = (plane: EventPlane, runId: string, item: string, cents: number) =>
  Effect.gen(function* () {
    yield* plane.publish(
      ChannelName('main'),
      Order.makeBound({ runId, contextId: 'ctx' }, { item, cents }),
    );
    yield* plane.awaitRunEnd(runId);
    while (inspectEventPlane(plane).activeRuns > 0) yield* Effect.sleep('1 millis');
  });

/** Four orders on one plane (warm reads; the third compacts), then a cold read after a restart. */
async function scenario(variant: 'in-memory' | 'json-clone') {
  const store = storeOf(variant);
  const warm: LedgerState[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* ledgerNetwork(store, warm, 'c').run();
      yield* order(plane, 'run-1', 'a', 100);
      yield* order(plane, 'run-2', 'b', 200);
      yield* order(plane, 'run-3', 'c', 300);
      yield* order(plane, 'run-4', 'd', 400);
    }).pipe(Effect.scoped),
  );
  const cold: LedgerState[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const plane = yield* ledgerNetwork(store, cold).run();
      yield* order(plane, 'run-5', 'e', 500);
    }).pipe(Effect.scoped),
  );
  const checkpoints = (
    await store.readContext({ namespace: 'anonymous', contextId: 'ctx' })
  ).events.filter(isFoldCheckpointEvent);
  return { warm, cold, checkpoints };
}

describe('folds over transforming schemas: the same state whatever the store does with JSON', () => {
  test('in-memory and JSON-cloning stores read equal states, warm and cold, across a compaction', async () => {
    const memory = await scenario('in-memory');
    const cloned = await scenario('json-clone');

    // Every read, warm (one plane) and cold (after a restart), is the same with either store.
    expect(cloned.warm).toStrictEqual(memory.warm);
    expect(cloned.cold).toStrictEqual(memory.cold);
    expect(memory.checkpoints).toHaveLength(1);

    const [, , , compacted, afterCompaction] = memory.warm;
    expect(compacted?.summary).toStrictEqual(Option.some('3 lines before c'));
    // The read after the compaction: the checkpoint state plus the events after its through.
    expect(afterCompaction?.lines.map((line) => line.item)).toEqual(['c', 'd']);
    // A cold read (new plane, same store) restores the checkpoint and folds the rest again.
    expect(memory.cold[0]?.lines.map((line) => line.item)).toEqual(['c', 'd', 'e']);
    expect(memory.cold[0]?.summary).toStrictEqual(Option.some('3 lines before c'));

    // Decoded with the schemas: real Dates, Options and class instances, not their JSON.
    const state = cloned.cold[0] as LedgerState;
    const [c, d] = state.lines;
    expect(c?.at).toBeInstanceOf(Date);
    expect(c?.at.getTime()).toBe(day(3).getTime());
    expect(c?.cents).toBe(300);
    expect(Option.isNone(c?.note ?? Option.some(''))).toBe(true);
    expect(d?.note).toStrictEqual(Option.some('even d'));
    expect(state.parcels.every((parcel) => parcel instanceof Parcel)).toBe(true);
    expect(state.parcels.map((parcel) => parcel.weight)).toEqual([1.5, 3, 4.5, 6, 7.5]);
    // The checkpoint holds the state as its schema encodes it, once.
    expect(memory.checkpoints[0]?.payload.state).toMatchObject({
      summary: { _tag: 'Some', value: '3 lines before c' },
      lines: [{ item: 'c', cents: '300', at: '2026-01-03T00:00:00.000Z', note: { _tag: 'None' } }],
    });
  });
});

describe('values with a toJSON in S.Unknown fields: folded as their JSON, warm and cold alike', () => {
  const Call = AgentNetworkEvent.of('call', S.Struct({ item: S.String, n: S.Number }));
  const ToolUsed = AgentNetworkEvent.of(
    'tool-used',
    S.Struct({ tool: S.String, output: S.Unknown }),
  );
  const Row = AgentNetworkEvent.of('row', S.Record({ key: S.String, value: S.Unknown }));
  const Outputs = ContextFold.of('outputs', {
    state: S.Struct({
      summary: S.optional(S.String),
      outputs: S.Array(S.Unknown),
      rows: S.Array(S.Record({ key: S.String, value: S.Unknown })),
    }),
  })
    .initial(() => ({ outputs: [], rows: [] }))
    .on(ToolUsed, (state, { payload }) => ({
      ...state,
      outputs: [...state.outputs, payload.output],
    }))
    .on(Row, (state, { payload }) => ({ ...state, rows: [...state.rows, payload] }));
  type OutputsState = typeof Outputs extends { initialState(): infer State } ? State : never;

  /** tool: call -> tool-used, row (Dates inside). reader: row -> reads, compacts on `compactOn`. */
  const toolNetwork = (store: AgentNetworkStore, reads: OutputsState[], compactOn?: string) =>
    AgentNetwork.setup(
      ({ mainChannel, registerAgent, endsOn }) => {
        const tool = AgentFactory.run()
          .listensTo([Call])
          .emits([ToolUsed, Row])
          .logic(async ({ triggerEvent, emit }) => {
            const { item, n } = triggerEvent.payload;
            emit({
              name: 'tool-used',
              payload: { tool: 'db', output: { item, rows: [{ createdAt: day(n) }] } },
            });
            emit({ name: 'row', payload: { item, createdAt: day(n), seenAt: [day(n + 1)] } });
          })
          .produce({});
        const reader = AgentFactory.run()
          .listensTo([Row])
          .emits([Done])
          .folds([Outputs])
          .logic(async ({ triggerEvent, folds, emit }) => {
            reads.push(await folds.outputs());
            if (triggerEvent.payload.item === compactOn) {
              reads.push(
                await folds.outputs.compact((state) => ({
                  summary: `${state.outputs.length} outputs`,
                  outputs: state.outputs.slice(-1),
                  rows: state.rows.slice(-1),
                })),
              );
            }
            emit(Done.make({}));
          })
          .produce({});
        registerAgent(tool).subscribe(mainChannel).publishTo(mainChannel);
        registerAgent(reader).subscribe(mainChannel).publishTo(mainChannel);
        endsOn(Done);
      },
      { store, logger: { warn: vi.fn(), error: vi.fn() } },
    );

  const call = (plane: EventPlane, runId: string, item: string, n: number) =>
    Effect.gen(function* () {
      yield* plane.publish(
        ChannelName('main'),
        Call.makeBound({ runId, contextId: 'ctx' }, { item, n }),
      );
      yield* plane.awaitRunEnd(runId);
      while (inspectEventPlane(plane).activeRuns > 0) yield* Effect.sleep('1 millis');
    });

  /** Three calls on one plane (warm reads; the second compacts), then a cold read. */
  async function toolScenario(variant: 'in-memory' | 'json-clone') {
    const store = storeOf(variant);
    const warm: OutputsState[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* toolNetwork(store, warm, 'b').run();
        yield* call(plane, 'run-1', 'a', 1);
        yield* call(plane, 'run-2', 'b', 2);
        yield* call(plane, 'run-3', 'c', 3);
      }).pipe(Effect.scoped),
    );
    const cold: OutputsState[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* toolNetwork(store, cold).run();
        yield* call(plane, 'run-4', 'd', 4);
      }).pipe(Effect.scoped),
    );
    return { warm, cold };
  }

  test('in-memory and JSON-cloning stores read equal states, warm and cold, across a compaction', async () => {
    const memory = await toolScenario('in-memory');
    const cloned = await toolScenario('json-clone');

    expect(cloned.warm).toStrictEqual(memory.warm);
    expect(cloned.cold).toStrictEqual(memory.cold);
    // Folds see what was stored: the ISO strings, never the Dates the tool emitted.
    const iso = (n: number) => day(n).toISOString();
    expect(memory.warm[0]).toStrictEqual({
      outputs: [{ item: 'a', rows: [{ createdAt: iso(1) }] }],
      rows: [{ item: 'a', createdAt: iso(1), seenAt: [iso(2)] }],
    });
    // The read after the compaction and the cold read after a restart agree on the checkpoint.
    const [, , compacted, third] = memory.warm;
    expect(compacted).toStrictEqual({
      summary: '2 outputs',
      outputs: [{ item: 'b', rows: [{ createdAt: iso(2) }] }],
      rows: [{ item: 'b', createdAt: iso(2), seenAt: [iso(3)] }],
    });
    expect(third?.rows.map((row) => row.item)).toEqual(['b', 'c']);
    expect(memory.cold[0]?.rows.map((row) => row.item)).toEqual(['b', 'c', 'd']);
    expect(memory.cold[0]?.summary).toBe('2 outputs');
  });
});
