import { describe, expect, expectTypeOf, test, vitest } from 'vitest';
import { Schema as S } from 'effect';
import { AgentNetworkEvent } from './agent-network-event';
import { EventAggregator } from './event-aggregator';

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

  test('mapToEmit receives triggerEvent, runEvents, and contextEvents', async () => {
    const MessageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
    const SummaryEvent = AgentNetworkEvent.of('summary', S.Struct({ summary: S.String }));

    const emitSpy = vitest.fn();
    const emitWhenSpy = vitest.fn().mockReturnValue(true);
    const mapSpy = vitest.fn();

    const aggregator = EventAggregator.listensTo([MessageEvent])
      .emits([SummaryEvent])
      .emitWhen(({ triggerEvent, contextEvents }) => {
        emitWhenSpy(triggerEvent.payload.text, contextEvents.all.length);
        return true;
      })
      .mapToEmit(({ triggerEvent, emit, runEvents, contextEvents }) => {
        mapSpy(runEvents.length, contextEvents.byRun('run-1').length);
        emit(
          SummaryEvent.make({
            summary: `${triggerEvent.payload.text} (${runEvents.length})`,
          }),
        );
      });

    await aggregator.invoke({
      triggerEvent: MessageEvent.makeBound(
        { runId: 'run-1', contextId: 'ctx-1' },
        { text: 'hello' },
      ),
      emit: emitSpy,
      runEvents: [
        MessageEvent.makeBound({ runId: 'run-1', contextId: 'ctx-1' }, { text: 'older-event' }),
      ],
      contextEvents: {
        all: [
          MessageEvent.makeBound({ runId: 'run-1', contextId: 'ctx-1' }, { text: 'older-event' }),
        ],
        byRun: () => [
          MessageEvent.makeBound({ runId: 'run-1', contextId: 'ctx-1' }, { text: 'older-event' }),
        ],
        map: new Map(),
      },
    });

    expect(emitWhenSpy).toHaveBeenCalledWith('hello', 1);
    expect(mapSpy).toHaveBeenCalledWith(1, 1);
    expect(emitSpy).toHaveBeenCalledWith({
      name: 'summary',
      payload: { summary: 'hello (1)' },
    });
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
});
