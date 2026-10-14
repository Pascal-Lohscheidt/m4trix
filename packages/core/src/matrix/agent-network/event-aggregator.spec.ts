import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vitest } from 'vitest';
import {
  ContextFold,
  ContextFoldDefinitionError,
  type FoldSource,
} from '../context/context-fold.js';
import type { FoldAccessors, FoldReader } from '../context/fold-reader.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import { EventAggregator } from './event-aggregator.js';
import { createEventHistory, type EventHistory } from './history.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

describe('EventAggregator', () => {
  test('creates an aggregator instance with the configured listensTo set', () => {
    const MessageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const SummaryEvent = AgentNetworkEvent.of('summary', S.Struct({ summary: S.String }));

    const aggregator = EventAggregator.listensTo([MessageEvent])
      .emits([SummaryEvent])
      .mapToEmit(({ triggerEvent, emit }) => {
        emit(SummaryEvent.make({ summary: triggerEvent.payload.text }));
      });

    expect(aggregator.getListensTo()).toEqual(['message']);
  });

  test('emitWhen(false) prevents any emission', async () => {
    const MessageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const SummaryEvent = AgentNetworkEvent.of('summary', S.Struct({ summary: S.String }));

    const mapSpy = vitest.fn();
    const emitSpy = vitest.fn();

    const aggregator = EventAggregator.listensTo([MessageEvent])
      .emits([SummaryEvent])
      .emitWhen(() => false)
      .mapToEmit(({ triggerEvent, emit }) => {
        mapSpy(triggerEvent.payload.text);
        emit(SummaryEvent.make({ summary: triggerEvent.payload.text }));
      });

    await aggregator.invoke({
      triggerEvent: MessageEvent.makeBound(
        { runId: 'run-1', contextId: 'ctx-1' },
        { text: 'hello' },
      ),
      emit: emitSpy,
    });

    expect(mapSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test('emitWhen and mapToEmit receive triggerEvent and history', async () => {
    const MessageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const SummaryEvent = AgentNetworkEvent.of('summary', S.Struct({ summary: S.String }));

    const emitSpy = vitest.fn();
    const emitWhenSpy = vitest.fn().mockReturnValue(true);
    const mapSpy = vitest.fn();
    const older = MessageEvent.makeBound({ runId: 'run-1', contextId: 'ctx-1' }, { text: 'older' });
    const history: EventHistory = {
      run: async () => [older],
      context: async () => ({ events: [older] }),
      latest: async () => undefined,
    };

    const aggregator = EventAggregator.listensTo([MessageEvent])
      .emits([SummaryEvent])
      .emitWhen(async ({ triggerEvent, history }) => {
        expectTypeOf(history).toEqualTypeOf<EventHistory>();
        emitWhenSpy(triggerEvent.payload.text, (await history.context()).events.length);
        return true;
      })
      .mapToEmit(async ({ triggerEvent, emit, history }) => {
        const runEvents = await history.run();
        mapSpy(runEvents.length);
        emit(SummaryEvent.make({ summary: `${triggerEvent.payload.text} (${runEvents.length})` }));
      });

    await aggregator.invoke({
      triggerEvent: MessageEvent.makeBound(
        { runId: 'run-1', contextId: 'ctx-1' },
        { text: 'hello' },
      ),
      emit: emitSpy,
      history,
    });

    expect(emitWhenSpy).toHaveBeenCalledWith('hello', 1);
    expect(mapSpy).toHaveBeenCalledWith(1);
    expect(emitSpy).toHaveBeenCalledWith({
      name: 'summary',
      payload: { summary: 'hello (1)' },
    });
  });

  test('outside a network the history is empty', async () => {
    const MessageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const seen = vitest.fn();
    const aggregator = EventAggregator.listensTo([MessageEvent]).mapToEmit(async ({ history }) => {
      seen(await history.run(), await history.context());
    });

    await aggregator.invoke({
      triggerEvent: MessageEvent.makeBound({ runId: 'r', contextId: 'c' }, { text: 'x' }),
    });

    expect(seen).toHaveBeenCalledWith([], { events: [] });
  });

  test('mapToEmit has typed triggerEvent and emit payload', () => {
    const MessageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const SummaryEvent = AgentNetworkEvent.of('summary', S.Struct({ summary: S.String }));

    EventAggregator.listensTo([MessageEvent])
      .emits([SummaryEvent])
      .mapToEmit(({ triggerEvent, emit }) => {
        expectTypeOf(triggerEvent.name).toEqualTypeOf<'message'>();
        expectTypeOf(emit).parameters.toEqualTypeOf<[ReturnType<typeof SummaryEvent.make>]>();

        emit(SummaryEvent.make({ summary: triggerEvent.payload.text }));
      });
  });

  describe('folds', () => {
    const Message = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const Summary = AgentNetworkEvent.of('summary', S.Struct({ count: S.Number }));
    const Messages = ContextFold.of('messages', { version: 1 })
      .over([Message])
      .initial((): readonly string[] => [])
      .on(Message, (texts, { payload }) => [...texts, payload.text]);
    const Count: FoldSource<'count', number> = {
      name: 'count',
      fold: Messages,
      select: async (state) => (state as readonly string[]).length,
    };
    const meta = { runId: 'run-1', contextId: 'ctx-1' };

    test('emitWhen and mapToEmit read ctx.folds over the invocation history', async () => {
      const store = createInMemoryNetworkStore();
      const key = { namespace: 'anonymous', contextId: 'ctx-1' };
      const trigger = Message.makeBound(meta, { text: 'b' });
      await store.append(key, Message.makeBound(meta, { text: 'a' }));
      await store.append(key, trigger);
      const emit = vitest.fn();
      const seen: unknown[] = [];

      const aggregator = EventAggregator.listensTo([Message])
        .folds([Messages])
        .emits([Summary])
        .folds([Count])
        .emitWhen(async ({ folds }) => {
          seen.push(await folds.messages());
          return (await folds.count()) >= 2;
        })
        .mapToEmit(async ({ folds, emit }) => {
          emit(Summary.make({ count: await folds.count() }));
        });

      await aggregator.invoke({
        triggerEvent: trigger,
        emit,
        history: createEventHistory(store, meta),
      });

      expect(seen).toEqual([['a', 'b']]);
      expect(emit).toHaveBeenCalledWith({ name: 'summary', payload: { count: 2 } });
      expect(aggregator.getFolds()).toEqual([Messages, Count]);
    });

    test('outside a network the folds select the initial state', async () => {
      const seen = vitest.fn();
      const aggregator = EventAggregator.listensTo([Message])
        .folds([Messages, Count])
        .mapToEmit(async ({ folds }) => {
          seen(await folds.messages(), await folds.count());
        });

      await aggregator.invoke({ triggerEvent: Message.makeBound(meta, { text: 'x' }) });

      expect(seen).toHaveBeenCalledWith([], 0);
    });

    test('a network passes its own reader', async () => {
      const foldReader = vitest.fn<FoldReader>(async () => 42);
      const seen = vitest.fn();
      const aggregator = EventAggregator.listensTo([Message])
        .folds([Count])
        .mapToEmit(async ({ folds }) => {
          seen(await folds.count());
        });

      await aggregator.invoke({ triggerEvent: Message.makeBound(meta, { text: 'x' }), foldReader });

      expect(seen).toHaveBeenCalledWith(42);
      expect(foldReader).toHaveBeenCalledWith(Count);
    });

    test('aggregators without folds get an empty ctx.folds', async () => {
      const seen = vitest.fn();
      const aggregator = EventAggregator.listensTo([Message]).mapToEmit(({ folds }) => {
        seen(folds);
      });

      await aggregator.invoke({ triggerEvent: Message.makeBound(meta, { text: 'x' }) });

      expect(seen).toHaveBeenCalledWith({});
      expect(aggregator.getFolds()).toEqual([]);
    });

    test('a name used twice throws; so does an incomplete fold', () => {
      const Incomplete = ContextFold.of('partial', { version: 1 })
        .over([Message, Summary])
        .initial(() => 0)
        .on(Message, (n) => n + 1);

      expect(() =>
        EventAggregator.listensTo([Message])
          .folds([Messages])
          // @ts-expect-error - "messages" was added by the previous call
          .folds([Messages]),
      ).toThrow('EventAggregator.folds: two fold sources are named "messages"');
      // @ts-expect-error - "summary" has no handler
      expect(() => EventAggregator.listensTo([Message]).folds([Incomplete])).toThrow(
        ContextFoldDefinitionError,
      );
    });

    test('types: ctx.folds in emitWhen and mapToEmit', () => {
      EventAggregator.listensTo([Message])
        .emits([Summary])
        .folds([Messages, Count])
        .emitWhen(({ folds, triggerEvent }) => {
          expectTypeOf(triggerEvent.name).toEqualTypeOf<'message'>();
          expectTypeOf(folds.messages).toEqualTypeOf<() => Promise<readonly string[]>>();
          expectTypeOf(folds.count).toEqualTypeOf<() => Promise<number>>();
          // @ts-expect-error - no source is named "chat"
          folds.chat;
          return true;
        })
        .mapToEmit(({ folds, emit }) => {
          expectTypeOf(folds).toEqualTypeOf<FoldAccessors<typeof Messages | typeof Count>>();
          expectTypeOf(emit).parameters.toEqualTypeOf<[ReturnType<typeof Summary.make>]>();
        });

      EventAggregator.listensTo([Message]).mapToEmit(({ folds }) => {
        expectTypeOf(folds).toEqualTypeOf<Record<never, never>>();
      });
    });
  });
});
