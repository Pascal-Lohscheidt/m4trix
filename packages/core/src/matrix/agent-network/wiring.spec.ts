import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { EmitsOptions } from '../agent-factory.js';
import { AgentFactory } from '../agent-factory.js';
import { ContextFold, type FoldSource } from '../context/context-fold.js';
import { Tool } from '../tool.js';
import {
  AgentNetwork,
  type AgentNetworkSetupOptions,
  type AnyAgent,
  type NetworkLogger,
} from './agent-network.js';
import { AgentNetworkEvent } from './agent-network-event.js';
import type { ConfiguredChannel } from './channel.js';
import { EventAggregator } from './event-aggregator.js';
import {
  type NetworkValidationResult,
  NetworkWiringError,
  type NetworkWiringOptions,
  type WiringErrorCode,
  type WiringIssue,
  type WiringWarningCode,
} from './wiring.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));
const note = AgentNetworkEvent.of('note', S.Struct({ from: S.String }));
const done = AgentNetworkEvent.of('done', S.Struct({}));

const recordingLogger = () => ({ warn: vi.fn<(message: string, data?: unknown) => void>() });

const agent = (
  options: {
    listensTo?: (typeof start)[];
    emits?: Array<typeof answer | typeof note | typeof done>;
  } = {},
) =>
  AgentFactory.run()
    .listensTo(options.listensTo ?? [start])
    .emits(options.emits ?? [])
    .logic(async () => {})
    .produce({});

const setupError = (fn: () => unknown): NetworkWiringError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof NetworkWiringError) return error;
    throw error;
  }
  throw new Error('setup did not throw');
};

describe('network wiring check', () => {
  test('setup fails on contradictions, listing every problem at once', () => {
    const emitter = agent({ emits: [note] });
    const listener = AgentFactory.run()
      .listensTo([note])
      .logic(async () => {})
      .produce({});
    const toolUser = AgentFactory.run()
      .listensTo([start])
      .tools(
        Tool.of({ name: 'noter', description: 'Notes' })
          .input(S.Struct({}))
          .output(S.Struct({}))
          .emits([note])
          .define(() => ({})),
      )
      .logic(async () => {})
      .produce({});

    const error = setupError(() =>
      AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const client = createChannel('client').events([answer]);
          registerAgent(emitter).subscribe(mainChannel).publishTo(client);
          registerAgent(listener).subscribe(client);
          registerAgent(toolUser).subscribe(mainChannel).publishTo(client);
        },
        { logger: recordingLogger() },
      ),
    );

    expect(error.errors.map((e) => [e.code, e.agentId, e.event])).toEqual([
      ['emit-not-accepted', emitter.getId(), 'note'],
      ['emit-not-accepted', toolUser.getId(), 'note'],
      ['listen-not-accepted', listener.getId(), 'note'],
    ]);
    for (const issue of error.errors) {
      expect(error.message).toContain(issue.message);
      expect(issue.channels).toEqual(['client']);
    }
    expect(error.message).toMatch(/3 problems/);
  });

  test('an event is fine when one of several channels accepts it', () => {
    const logger = recordingLogger();
    const emitter = agent({ emits: [note, answer] });
    const listener = AgentFactory.run()
      .listensTo([note])
      .logic(async () => {})
      .produce({});

    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent, proxy }) => {
        const client = createChannel('client').events([answer]).proxy(proxy.sse());
        const internal = createChannel('internal').events([note]);
        registerAgent(emitter).subscribe(mainChannel).publishTo(client).publishTo(internal);
        registerAgent(listener).subscribe(client).subscribe(internal);
      },
      { logger },
    );

    expect(network.validate()).toEqual({ errors: [], warnings: [] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('smells are logged as warnings through the injected logger', () => {
    const logger = recordingLogger();
    const unconsumed = agent({ emits: [note] });
    const loner = agent();
    const deaf = AgentFactory.run()
      .listensTo([answer])
      .logic(async () => {})
      .produce({});
    const mute = agent({ emits: [answer] });

    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent, endsOn }) => {
        const internal = createChannel('internal');
        const side = createChannel('side');
        registerAgent(unconsumed).subscribe(mainChannel).publishTo(internal);
        registerAgent(loner);
        registerAgent(deaf).subscribe(side);
        registerAgent(mute).subscribe(mainChannel);
        endsOn(done);
      },
      { logger },
    );

    const { errors, warnings } = network.validate();
    expect(errors).toEqual([]);
    expect(warnings.map((w) => [w.code, w.agentId, w.event])).toEqual([
      ['unconsumed-event', unconsumed.getId(), 'note'],
      ['agent-publishes-nowhere', mute.getId(), undefined],
      ['agent-not-subscribed', loner.getId(), undefined],
      ['agent-unreachable', deaf.getId(), undefined],
      ['terminal-event-not-emitted', undefined, 'done'],
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(warnings.length);
    for (const warning of warnings) {
      expect(logger.warn).toHaveBeenCalledWith(`[m4trix] ${warning.message}`, warning);
    }
  });

  test('events streamed to a proxy channel, listened to, or ending the run are consumed', () => {
    const logger = recordingLogger();
    const emitter = agent({ emits: [answer, note, done] });
    const listener = AgentFactory.run()
      .listensTo([note])
      .logic(async () => {})
      .produce({});

    AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent, proxy, endsOn }) => {
        const client = createChannel('client').proxy(proxy.sse());
        const internal = createChannel('internal');
        registerAgent(emitter).subscribe(mainChannel).publishTo(client).publishTo(internal);
        registerAgent(listener).subscribe(internal);
        endsOn(done);
      },
      { logger },
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  describe('reply events', () => {
    /** Asks on `work` with emitAndAwait; the answerer replies there and nobody else listens. */
    const replyNetwork = (answerer: AnyAgent, logger = recordingLogger()) => {
      const asker = AgentFactory.run()
        .listensTo([start])
        .emits([note])
        .logic(async () => {})
        .produce({});
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          const work = createChannel('work');
          registerAgent(asker).subscribe(mainChannel).publishTo(work);
          registerAgent(answerer).subscribe(work).publishTo(work);
        },
        { logger },
      );
      return { network, logger };
    };

    test('an event declared as a reply is not reported as unconsumed', () => {
      const answerer = AgentFactory.run()
        .listensTo([note])
        .emits([answer], { reply: true })
        .logic(async () => {})
        .produce({});

      const { network, logger } = replyNetwork(answerer);

      expect(answerer.getReplyEvents()).toEqual(['answer']);
      expect(network.validate().warnings).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('without the reply option the same event is reported', () => {
      const answerer = AgentFactory.run()
        .listensTo([note])
        .emits([answer])
        .logic(async () => {})
        .produce({});

      const { network } = replyNetwork(answerer);

      expect(network.validate().warnings).toEqual([
        expect.objectContaining({
          code: 'unconsumed-event',
          event: 'answer',
          message: expect.stringContaining('{ reply: true }'),
        }),
      ]);
    });

    test("a tool's reply events count for its agent", () => {
      const replier = Tool.of({ name: 'replier', description: 'Replies' })
        .input(S.Struct({}))
        .output(S.Struct({}))
        .emits([answer], { reply: true })
        .define(async () => ({}));
      const answerer = AgentFactory.run()
        .listensTo([note])
        .tools(replier)
        .logic(async () => {})
        .produce({});

      const { network } = replyNetwork(answerer);

      expect(replier.replyEvents).toEqual(['answer']);
      expect(answerer.getReplyEvents()).toEqual(['answer']);
      expect(network.validate().warnings).toEqual([]);
    });

    test('a reply event must still be accepted by the channels it goes to', () => {
      const answerer = AgentFactory.run()
        .listensTo([note])
        .emits([answer], { reply: true })
        .logic(async () => {})
        .produce({});

      const error = setupError(() =>
        AgentNetwork.setup(
          ({ mainChannel, createChannel, registerAgent }) => {
            const work = createChannel('work').events([note]);
            registerAgent(agent({ emits: [note] }))
              .subscribe(mainChannel)
              .publishTo(work);
            registerAgent(answerer).subscribe(work).publishTo(work);
          },
          { logger: recordingLogger() },
        ),
      );

      expect(error.errors.map((e) => e.code)).toEqual(['emit-not-accepted']);
    });
  });

  describe('fold events', () => {
    const Conversation = ContextFold.of('conversation', { version: 1 })
      .over([start, answer, note, done])
      .initial(() => 0)
      .on(start, (n) => n + 1)
      .on(answer, (n) => n + 1)
      .on(note, (n) => n + 1)
      .on(done, (n) => n + 1);
    const Count: FoldSource<'count', number> = {
      name: 'count',
      fold: Conversation,
      select: (state) => state as number,
    };
    const reader = (sources: ReadonlyArray<FoldSource> = [Conversation]) =>
      AgentFactory.run()
        .listensTo([start])
        .folds(sources as [typeof Conversation])
        .logic(async () => {})
        .produce({});
    const foldWarnings = (result: NetworkValidationResult) =>
      result.warnings.filter((w) => w.code === 'fold-event-unpublished');

    test('warns about a folded event nothing can publish', () => {
      const logger = recordingLogger();
      const folder = reader([Conversation, Count]);
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent }) => {
          mainChannel.events([start]);
          const work = createChannel('work');
          registerAgent(folder).subscribe(mainChannel);
          registerAgent(agent({ emits: [answer] }))
            .subscribe(mainChannel)
            .publishTo(work);
        },
        { logger },
      );

      // `start` comes from outside (main), `answer` from an agent; nothing publishes the others.
      // The fold and its view read the same events: each is reported once.
      expect(foldWarnings(network.validate())).toEqual([
        {
          code: 'fold-event-unpublished',
          message: expect.stringContaining(
            `agent "${folder.getId()}" (listens to "start"; emits nothing) folds "note" (fold "conversation"), but nothing publishes it`,
          ),
          agentId: folder.getId(),
          event: 'note',
        },
        expect.objectContaining({ agentId: folder.getId(), event: 'done' }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('folds "note"'),
        expect.objectContaining({ code: 'fold-event-unpublished', event: 'note' }),
      );
    });

    test('events that may come from outside or from any agent are not reported', () => {
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, registerAgent, proxy }) => {
          mainChannel.events([start]);
          // Declared on a channel: it may be published there (e.g. with plane.publish).
          createChannel('notes').events([note]);
          // Fed by a receiving proxy: anything it accepts may arrive.
          createChannel('inbox')
            .events([answer])
            .proxy(proxy.custom('queue', {}, 'inbound'));
          const anything: AnyAgent = {
            getId: () => 'custom-agent',
            invoke: async () => {},
            getListensTo: () => ['start'],
          };
          // An agent that does not say what it emits may emit `done`.
          registerAgent(anything).subscribe(mainChannel).publishTo(createChannel('free'));
          registerAgent(reader()).subscribe(mainChannel);
        },
        { logger: recordingLogger() },
      );

      expect(foldWarnings(network.validate())).toEqual([]);
    });

    test('an open main channel can carry any folded event', () => {
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          registerAgent(reader()).subscribe(mainChannel);
        },
        { logger: recordingLogger() },
      );

      expect(foldWarnings(network.validate())).toEqual([]);
    });

    test("an aggregator's folds are checked too", () => {
      const aggregator = EventAggregator.listensTo([start])
        .folds([Conversation])
        .mapToEmit(() => {});
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAggregator }) => {
          mainChannel.events([start, answer, done]);
          registerAggregator(aggregator).subscribe(mainChannel);
        },
        { logger: recordingLogger() },
      );

      expect(foldWarnings(network.validate())).toEqual([
        expect.objectContaining({ agentId: aggregator.getId(), event: 'note' }),
      ]);
    });

    test('wiring.ignore silences it', () => {
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          mainChannel.events([start]);
          registerAgent(reader()).subscribe(mainChannel);
        },
        { logger: recordingLogger(), wiring: { ignore: ['fold-event-unpublished'] } },
      );

      expect(foldWarnings(network.validate())).toEqual([]);
    });

    describe('a folded event counts as consumed', () => {
      const unconsumed = (result: NetworkValidationResult) =>
        result.warnings.filter((w) => w.code === 'unconsumed-event');
      /** Emits `note` to a `work` channel that no agent listens to. */
      const noter = () => agent({ emits: [note] });

      test('on any channel: folds read the store, which keeps every durable event', () => {
        const logger = recordingLogger();
        const network = AgentNetwork.setup(
          ({ mainChannel, createChannel, registerAgent }) => {
            registerAgent(noter()).subscribe(mainChannel).publishTo(createChannel('work'));
            // Subscribed to main only, yet its fold reads the notes published to `work`.
            registerAgent(reader([Count])).subscribe(mainChannel);
          },
          { logger },
        );

        expect(network.validate().warnings).toEqual([]);
        expect(logger.warn).not.toHaveBeenCalled();
      });

      test("by an aggregator's fold too", () => {
        const network = AgentNetwork.setup(
          ({ mainChannel, createChannel, registerAgent, registerAggregator }) => {
            registerAgent(noter()).subscribe(mainChannel).publishTo(createChannel('work'));
            registerAggregator(
              EventAggregator.listensTo([start])
                .folds([Conversation])
                .mapToEmit(() => {}),
            ).subscribe(mainChannel);
          },
          { logger: recordingLogger() },
        );

        expect(unconsumed(network.validate())).toEqual([]);
      });

      test('events no fold reads are still reported', () => {
        const Answers = ContextFold.of('answers', { version: 1 })
          .over([answer])
          .initial(() => 0)
          .on(answer, (n) => n + 1);
        const network = AgentNetwork.setup(
          ({ mainChannel, createChannel, registerAgent }) => {
            const work = createChannel('work');
            registerAgent(agent({ emits: [note, answer] }))
              .subscribe(mainChannel)
              .publishTo(work);
            registerAgent(reader([Answers])).subscribe(mainChannel);
          },
          { logger: recordingLogger() },
        );

        expect(unconsumed(network.validate())).toEqual([
          expect.objectContaining({
            event: 'note',
            message: expect.stringContaining('reaches no listening agent, no fold and no proxy'),
          }),
        ]);
      });

      test('a transient event is never stored, so a fold does not consume it', () => {
        const tick = AgentNetworkEvent.of('tick', S.Struct({}), { transient: true });
        const Ticks = ContextFold.of('ticks', { version: 1 })
          .over([tick])
          .initial(() => 0)
          .on(tick, (n) => n + 1);
        const ticker = AgentFactory.run()
          .listensTo([start])
          .emits([tick])
          .logic(async () => {})
          .produce({});
        const network = AgentNetwork.setup(
          ({ mainChannel, createChannel, registerAgent }) => {
            registerAgent(ticker).subscribe(mainChannel).publishTo(createChannel('work'));
            registerAgent(reader([Ticks])).subscribe(mainChannel);
          },
          { logger: recordingLogger() },
        );

        expect(unconsumed(network.validate())).toEqual([
          expect.objectContaining({ event: 'tick', agentId: ticker.getId() }),
        ]);
      });
    });
  });

  describe('wiring.ignore', () => {
    test('silences the listed warning codes at setup and in validate()', () => {
      const logger = recordingLogger();
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          registerAgent(agent({ emits: [note] }))
            .subscribe(mainChannel)
            .publishTo(mainChannel);
          registerAgent(agent());
        },
        { logger, wiring: { ignore: ['unconsumed-event'] } },
      );

      expect(network.validate().warnings.map((w) => w.code)).toEqual(['agent-not-subscribed']);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('is not subscribed to any channel'),
        expect.objectContaining({ code: 'agent-not-subscribed' }),
      );
    });

    test('never silences errors', () => {
      const error = setupError(() =>
        AgentNetwork.setup(
          ({ mainChannel, createChannel, registerAgent }) => {
            const client = createChannel('client').events([answer]);
            registerAgent(agent({ emits: [note] }))
              .subscribe(mainChannel)
              .publishTo(client);
          },
          {
            logger: recordingLogger(),
            // @ts-expect-error errors cannot be ignored
            wiring: { ignore: ['emit-not-accepted'] },
          },
        ),
      );

      expect(error.errors.map((e) => e.code)).toEqual(['emit-not-accepted']);
    });
  });

  test('network.validate() reports problems introduced after setup without throwing', () => {
    let client: ConfiguredChannel | undefined;
    const emitter = agent({ emits: [note] });
    const network = AgentNetwork.setup(
      ({ mainChannel, createChannel, registerAgent, proxy }) => {
        client = createChannel('client').proxy(proxy.sse());
        registerAgent(emitter).subscribe(mainChannel).publishTo(client);
      },
      { logger: recordingLogger() },
    );
    client?.events([answer]);

    const result = network.validate();

    expect(result.errors).toEqual([
      {
        code: 'emit-not-accepted',
        message: expect.stringContaining('"note"'),
        agentId: emitter.getId(),
        event: 'note',
        channels: ['client'],
      },
    ]);
  });

  test('types', () => {
    const network = AgentNetwork.setup(() => {}, { logger: recordingLogger() });
    expectTypeOf(network.validate()).toEqualTypeOf<NetworkValidationResult>();
    expectTypeOf<NetworkValidationResult>().toEqualTypeOf<{
      readonly errors: ReadonlyArray<WiringIssue<WiringErrorCode>>;
      readonly warnings: ReadonlyArray<WiringIssue<WiringWarningCode>>;
    }>();
    expectTypeOf<WiringErrorCode>().toEqualTypeOf<'emit-not-accepted' | 'listen-not-accepted'>();
    expectTypeOf<WiringWarningCode>().toEqualTypeOf<
      | 'unconsumed-event'
      | 'agent-publishes-nowhere'
      | 'agent-not-subscribed'
      | 'agent-unreachable'
      | 'terminal-event-not-emitted'
      | 'fold-event-unpublished'
    >();
    expectTypeOf<AgentNetworkSetupOptions['wiring']>().toEqualTypeOf<
      NetworkWiringOptions | undefined
    >();
    expectTypeOf<NetworkWiringOptions>().toEqualTypeOf<{
      readonly ignore?: ReadonlyArray<WiringWarningCode>;
    }>();
    expectTypeOf<EmitsOptions>().toEqualTypeOf<{ readonly reply?: boolean }>();
    expectTypeOf(AgentFactory.run().emits).parameter(1).toEqualTypeOf<EmitsOptions | undefined>();
    expectTypeOf(Tool.of({ name: 't', description: 'd' }).emits)
      .parameter(1)
      .toEqualTypeOf<EmitsOptions | undefined>();
    expectTypeOf<NetworkWiringError['errors']>().toEqualTypeOf<
      ReadonlyArray<WiringIssue<WiringErrorCode>>
    >();
    expectTypeOf<AgentNetworkSetupOptions['logger']>().toEqualTypeOf<NetworkLogger | undefined>();
    // Any logger with a compatible `warn` fits, e.g. console or a full leveled logger.
    expectTypeOf(console).toMatchTypeOf<NetworkLogger>();
    expectTypeOf<{
      debug(message: string, data?: unknown): void;
      info(message: string, data?: unknown): void;
      warn(message: string, data?: unknown): void;
      error(message: string, data?: unknown): void;
    }>().toMatchTypeOf<NetworkLogger>();
  });
});
