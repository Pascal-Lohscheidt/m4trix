import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { EmitsOptions } from '../agent-factory.js';
import { AgentFactory } from '../agent-factory.js';
import { type AnyContextFold, ContextFold } from '../context/context-fold.js';
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
    const Conversation = ContextFold.of('conversation')
      .initial(() => 0)
      .on(start, (n) => n + 1)
      .on(answer, (n) => n + 1)
      .on(note, (n) => n + 1)
      .on(done, (n) => n + 1);
    /** A second fold of the same agent, over some of the same events. */
    const Notes = ContextFold.of('notes')
      .initial(() => 0)
      .on(note, (n) => n + 1)
      .on(done, (n) => n + 1);
    const reader = (folds: ReadonlyArray<AnyContextFold> = [Conversation]) =>
      AgentFactory.run()
        .listensTo([start])
        .folds(folds as [typeof Conversation])
        .logic(async () => {})
        .produce({});
    const foldWarnings = (result: NetworkValidationResult) =>
      result.warnings.filter((w) => w.code === 'fold-event-unpublished');

    test('warns about a folded event nothing can publish', () => {
      const logger = recordingLogger();
      const folder = reader([Conversation, Notes]);
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
      // Both folds read note and done: each event is reported once per agent.
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
            registerAgent(reader([Conversation])).subscribe(mainChannel);
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
        const Answers = ContextFold.of('answers')
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
        const Ticks = ContextFold.of('ticks')
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

  describe('folds sharing a name', () => {
    // Without a state schema: such folds can never compact, so they have no checkpoints.
    const makeCount = () =>
      ContextFold.of('conversation')
        .initial(() => 0)
        .on(start, (n) => n + 1);
    // With one, in context scope: they compact, and their checkpoints are stored by name+version.
    const makeLog = (version = 1) =>
      ContextFold.of('conversation', { state: S.Array(S.String), version })
        .initial(() => [])
        .on(start, (lines) => [...lines, 'start']);
    const Conversation = makeCount();
    const issues = (result: NetworkValidationResult) =>
      [...result.errors, ...result.warnings].filter((issue) =>
        ['fold-name-shared', 'fold-checkpoint-shared'].includes(issue.code),
      );
    const reads = (fold: AnyContextFold) =>
      AgentFactory.run()
        .listensTo([start])
        .folds([fold as typeof Conversation])
        .logic(async () => {})
        .produce({});
    const reader = (id: string) => `agent "${id}" (listens to "start"; emits nothing)`;

    test('folds that would share checkpoints fail setup: compactable, one name and version', () => {
      const logger = recordingLogger();
      // A factory-built copy: the same definition, but another fold object.
      const model = reads(makeLog());
      const auditor = reads(makeLog());
      const aggregator = EventAggregator.listensTo([start])
        .folds([makeLog()])
        .mapToEmit(() => {});
      const error = setupError(() =>
        AgentNetwork.setup(
          ({ mainChannel, registerAgent, registerAggregator }) => {
            registerAgent(model).subscribe(mainChannel);
            registerAgent(auditor).subscribe(mainChannel);
            registerAggregator(aggregator).subscribe(mainChannel);
          },
          { logger },
        ),
      );

      const message =
        `3 different folds named "conversation" would share the checkpoints ` +
        `"m4trix:fold.checkpoint:conversation@1": #1 read by ${reader(model.getId())}, ` +
        `#2 read by ${reader(auditor.getId())}, #3 read by ${reader(aggregator.getId())}. ` +
        'Checkpoints are stored by fold name and version, so each would restore states the ' +
        'others wrote: give each fold its own name (or version), or define it once and share ' +
        'that object';
      expect(error.errors).toEqual([{ code: 'fold-checkpoint-shared', message }]);
      expect(error.message).toContain(message);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('folds that share a name but no checkpoints only warn, by agents and aggregators', () => {
      const logger = recordingLogger();
      // A schema-less copy: it can never compact, so nothing is shared in the store.
      const Copy = makeCount();
      const model = reads(Conversation);
      const auditor = reads(Copy);
      const aggregator = EventAggregator.listensTo([start])
        .folds([Copy])
        .mapToEmit(() => {});
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent, registerAggregator }) => {
          registerAgent(model).subscribe(mainChannel);
          registerAgent(auditor).subscribe(mainChannel);
          registerAggregator(aggregator).subscribe(mainChannel);
        },
        { logger },
      );

      const message =
        `2 different folds are named "conversation": #1 read by ${reader(model.getId())}, ` +
        `#2 read by ${reader(auditor.getId())} and ${reader(aggregator.getId())}. Each one is ` +
        'folded and cached on its own, and the m4trix.fold.read.events metric reports them as ' +
        'one fold: give each fold its own name, or define it once and share that object';
      expect(issues(network.validate())).toEqual([{ code: 'fold-name-shared', message }]);
      expect(logger.warn).toHaveBeenCalledWith(`[m4trix] ${message}`, {
        code: 'fold-name-shared',
        message,
      });
    });

    test.each([
      ['two versions of a compactable fold', () => [makeLog(1), makeLog(2)]],
      ['a compactable fold and a schema-less one', () => [makeLog(), makeCount()]],
      [
        'a context-scoped and a run-scoped fold',
        () => [
          makeLog(),
          ContextFold.of('conversation', { state: S.Array(S.String), scope: 'run' })
            .initial(() => [])
            .on(start, (lines) => lines),
        ],
      ],
    ])('%s share no checkpoints: a warning', (_, folds) => {
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          for (const fold of folds()) registerAgent(reads(fold)).subscribe(mainChannel);
        },
        { logger: recordingLogger() },
      );

      expect(issues(network.validate()).map((issue) => issue.code)).toEqual(['fold-name-shared']);
    });

    test('one fold object shared by agents and aggregators is fine', () => {
      const Replies = ContextFold.of('replies')
        .initial(() => 0)
        .on(answer, (n) => n + 1);
      const Log = makeLog();
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent, registerAggregator }) => {
          registerAgent(
            AgentFactory.run()
              .listensTo([start])
              .folds([Conversation, Replies])
              .logic(async () => {})
              .produce({}),
          ).subscribe(mainChannel);
          registerAgent(reads(Conversation)).subscribe(mainChannel);
          registerAgent(
            AgentFactory.run()
              .listensTo([start])
              .folds([Log])
              .logic(async () => {})
              .produce({}),
          );
          registerAggregator(
            EventAggregator.listensTo([start])
              .folds([Conversation, Replies])
              .mapToEmit(() => {}),
          ).subscribe(mainChannel);
        },
        { logger: recordingLogger(), wiring: { ignore: ['agent-not-subscribed'] } },
      );

      // The name "conversation" is still read through two folds (Conversation and Log): a warning.
      expect(issues(network.validate()).map((issue) => issue.code)).toEqual(['fold-name-shared']);
    });

    test('wiring.ignore silences the warning, never the error', () => {
      const logger = recordingLogger();
      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          registerAgent(reads(Conversation)).subscribe(mainChannel);
          registerAgent(reads(makeCount())).subscribe(mainChannel);
        },
        { logger, wiring: { ignore: ['fold-name-shared'] } },
      );
      const error = setupError(() =>
        AgentNetwork.setup(
          ({ mainChannel, registerAgent }) => {
            registerAgent(reads(makeLog())).subscribe(mainChannel);
            registerAgent(reads(makeLog())).subscribe(mainChannel);
          },
          // @ts-expect-error - errors cannot be ignored
          { logger: recordingLogger(), wiring: { ignore: ['fold-checkpoint-shared'] } },
        ),
      );

      expect(issues(network.validate())).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(error.errors.map((e) => e.code)).toEqual(['fold-checkpoint-shared']);
    });
  });

  describe('event definitions', () => {
    const StampText = AgentNetworkEvent.of('stamp', S.Struct({ at: S.String }));
    const StampDate = AgentNetworkEvent.of('stamp', S.Struct({ at: S.Date }));
    const Stamps = ContextFold.of('stamps')
      .initial(() => 0)
      .on(StampDate, (count) => count + 1);
    const stamper = (emits: typeof StampDate | typeof StampText = StampDate) =>
      AgentFactory.run()
        .listensTo([start])
        .emits([emits])
        .folds([Stamps])
        .logic(async () => {})
        .produce({});
    const warningsOf = (
      setup: Parameters<typeof AgentNetwork.setup>[0],
      code: WiringWarningCode,
      options: AgentNetworkSetupOptions = {},
    ) =>
      AgentNetwork.setup(setup, { logger: recordingLogger(), ...options })
        .validate()
        .warnings.filter((warning) => warning.code === code);

    test('one event name with different payload schemas is a warning naming each definition', () => {
      const agent = stamper();

      const warnings = warningsOf(({ mainChannel, registerAgent }) => {
        mainChannel.events([start, StampText]);
        registerAgent(agent).subscribe(mainChannel).publishTo(mainChannel);
      }, 'event-schema-mismatch');

      expect(warnings).toEqual([
        {
          code: 'event-schema-mismatch',
          event: 'stamp',
          message:
            '"stamp" has 2 different payload schemas: { readonly at: string } (channel ' +
            `"main"); { readonly at: Date } (emitted by agent "${agent.getId()}", handled by fold ` +
            '"stamps"). Events published from outside are encoded with the first, emits with the ' +
            "emitter's own definition and folds decode with their handler's, so a payload stored " +
            'with one may not decode with another (folds skip it and report it): give the event ' +
            'one definition and share it',
        },
      ]);
    });

    test('one definition everywhere, or equal schemas made twice, are fine', () => {
      const Again = AgentNetworkEvent.of('stamp', S.Struct({ at: S.Date }));

      const warnings = warningsOf(({ mainChannel, registerAgent }) => {
        mainChannel.events([start, Again]);
        registerAgent(stamper()).subscribe(mainChannel).publishTo(mainChannel);
      }, 'event-schema-mismatch');

      expect(warnings).toEqual([]);
    });

    test('schemas with bigint annotations (e.g. a bound) are compared like any other', () => {
      const positive = (min: bigint) => S.Struct({ n: S.BigInt.pipe(S.greaterThanBigInt(min)) });
      const One = AgentNetworkEvent.of('big', positive(0n));
      const OneAgain = AgentNetworkEvent.of('big', positive(0n));
      const Two = AgentNetworkEvent.of('big', positive(1n));
      const listener = (event: typeof One) =>
        AgentFactory.run()
          .listensTo([event])
          .logic(async () => {})
          .produce({});

      const mismatchesWith = (other: typeof One) =>
        warningsOf(({ mainChannel, registerAgent }) => {
          mainChannel.events([One]);
          registerAgent(listener(other)).subscribe(mainChannel);
        }, 'event-schema-mismatch');

      expect(mismatchesWith(OneAgain)).toEqual([]);
      expect(mismatchesWith(Two)).toEqual([
        expect.objectContaining({ code: 'event-schema-mismatch', event: 'big' }),
      ]);
    });

    test('a schema JSON cannot describe (a cyclic annotation) never fails setup, nor warns', () => {
      const cyclic: Record<string, unknown> = { a: 'x' };
      cyclic.self = cyclic;
      const Odd = AgentNetworkEvent.of(
        'odd',
        S.Struct({ a: S.String }).annotations({ examples: [cyclic as never] }),
      );
      const Plain = AgentNetworkEvent.of('odd', S.Struct({ a: S.String }));
      const listener = (event: typeof Plain) =>
        AgentFactory.run()
          .listensTo([event])
          .logic(async () => {})
          .produce({});
      const mismatchesWith = (other: typeof Plain) =>
        warningsOf(({ mainChannel, registerAgent }) => {
          mainChannel.events([Odd]);
          registerAgent(listener(other)).subscribe(mainChannel);
        }, 'event-schema-mismatch');

      // The same definition everywhere is one; another cannot be compared with it: no warning.
      expect(mismatchesWith(Odd)).toEqual([]);
      expect(mismatchesWith(Plain)).toEqual([]);
    });

    test('a durable event whose schema encodes to something JSON cannot hold is a warning', () => {
      const Raw = AgentNetworkEvent.of('raw', S.Struct({ at: S.DateFromSelf }));
      const Live = AgentNetworkEvent.of('live', S.Struct({ at: S.DateFromSelf }), {
        transient: true,
      });
      const Fine = AgentNetworkEvent.of('fine', S.Struct({ at: S.Date }));
      const emitter = AgentFactory.run()
        .listensTo([start])
        .emits([Raw, Live, Fine])
        .logic(async () => {})
        .produce({});

      const warnings = warningsOf(
        ({ mainChannel, registerAgent }) => {
          registerAgent(emitter).subscribe(mainChannel).publishTo(mainChannel);
        },
        'event-not-storable',
        { wiring: { ignore: ['unconsumed-event'] } },
      );

      // Transient events are never stored: `live` is fine.
      expect(warnings).toEqual([
        {
          code: 'event-not-storable',
          event: 'raw',
          message:
            '"raw" cannot be stored with a value at at: its schema encodes it as DateFromSelf, ' +
            'which JSON cannot hold (durable events are stored as JSON, encoded with their ' +
            'schema), so publishing one fails. Give it a schema that encodes to JSON (e.g. S.Date ' +
            'instead of S.DateFromSelf), or make the event transient. Defined by: emitted by ' +
            `agent "${emitter.getId()}"`,
        },
      ]);
    });

    test('at the root of a payload, by a fold, a listener or a channel alike', () => {
      const Raw = AgentNetworkEvent.of('raw', S.DateFromSelf);
      const Read = ContextFold.of('read')
        .initial(() => 0)
        .on(Raw, (count) => count + 1);
      const reader = AgentFactory.run()
        .listensTo([Raw])
        .folds([Read])
        .logic(async () => {})
        .produce({});

      const [warning] = warningsOf(({ mainChannel, registerAgent }) => {
        mainChannel.events([Raw]);
        registerAgent(reader).subscribe(mainChannel);
      }, 'event-not-storable');

      expect(warning?.message).toContain('"raw" cannot be stored with a value at (root)');
      expect(warning?.message).toContain(
        `Defined by: channel "main", listened to by agent "${reader.getId()}", handled by fold ` +
          '"read"',
      );
    });

    test('wiring.ignore silences both', () => {
      const Raw = AgentNetworkEvent.of('stamp', S.Struct({ at: S.DateFromSelf }));
      const setup: Parameters<typeof AgentNetwork.setup>[0] = ({ mainChannel, registerAgent }) => {
        mainChannel.events([start, Raw]);
        registerAgent(stamper()).subscribe(mainChannel).publishTo(mainChannel);
      };
      const ignore = {
        wiring: { ignore: ['event-schema-mismatch', 'event-not-storable'] },
      } as const;

      expect(warningsOf(setup, 'event-schema-mismatch')).toHaveLength(1);
      expect(warningsOf(setup, 'event-not-storable')).toHaveLength(1);
      expect(warningsOf(setup, 'event-schema-mismatch', ignore)).toEqual([]);
      expect(warningsOf(setup, 'event-not-storable', ignore)).toEqual([]);
    });
  });

  describe('S.Redacted in durable events', () => {
    const redactedErrors = (setup: Parameters<typeof AgentNetwork.setup>[0]) =>
      setupError(() =>
        AgentNetwork.setup(setup, {
          logger: recordingLogger(),
          wiring: { ignore: ['unconsumed-event', 'fold-event-unpublished'] },
        }),
      ).errors.filter((error) => error.code === 'durable-event-redacted');

    test.each<[string, S.Schema.Any, string]>([
      [
        'a nested field',
        S.Struct({ creds: S.Struct({ password: S.Redacted(S.String) }) }),
        'creds.password',
      ],
      ['an optional field', S.Struct({ token: S.optional(S.Redacted(S.String)) }), 'token'],
      ['a union member', S.Struct({ key: S.Union(S.Null, S.Redacted(S.String)) }), 'key'],
      [
        'behind a suspension',
        S.Struct({ inner: S.suspend(() => S.Struct({ pin: S.Redacted(S.String) })) }),
        'inner.pin',
      ],
      ['the payload itself', S.RedactedFromSelf(S.String), '(root)'],
    ])('fail setup, in %s', (_label, schema, at) => {
      const Login = AgentNetworkEvent.of('login', schema);
      const emitter = AgentFactory.run()
        .listensTo([start])
        .emits([Login])
        .logic(async () => {})
        .produce({});

      const errors = redactedErrors(({ mainChannel, registerAgent }) => {
        registerAgent(emitter).subscribe(mainChannel).publishTo(mainChannel);
      });

      expect(errors).toEqual([
        {
          code: 'durable-event-redacted',
          event: 'login',
          message:
            `"login" is durable, but its schema holds S.Redacted (at ${at}): durable events are ` +
            'stored and streamed encoded with their schema, which puts the secret in clear. Mark ' +
            'the event transient (AgentNetworkEvent.of(name, schema, { transient: true }) in the ' +
            'listensTo or emits of its agents: never stored, and streamed as "<redacted>"; a ' +
            'transient definition only on a channel or a fold does not count, the plane stores ' +
            'the event), or remove the secret from its payload. Defined by: emitted by agent ' +
            `"${emitter.getId()}"`,
        },
      ]);
    });

    test('a transient event may hold one: it is never stored', () => {
      const Typing = AgentNetworkEvent.of(
        'typing',
        S.Struct({ token: S.Redacted(S.String), text: S.String }),
        { transient: true },
      );
      const emitter = AgentFactory.run()
        .listensTo([start])
        .emits([Typing])
        .logic(async () => {})
        .produce({});

      const network = AgentNetwork.setup(
        ({ mainChannel, registerAgent }) => {
          registerAgent(emitter).subscribe(mainChannel).publishTo(mainChannel);
        },
        { logger: recordingLogger(), wiring: { ignore: ['unconsumed-event'] } },
      );

      expect(network.validate().errors).toEqual([]);
    });

    test('durable unless an agent declares it transient: a channel or a fold alone does not', () => {
      const Secret = AgentNetworkEvent.of('secret', S.Struct({ key: S.Redacted(S.String) }));
      // Transient on the channel only: no agent declares it, so the plane stores it.
      const Marked = AgentNetworkEvent.of('marked', S.Struct({ key: S.Redacted(S.String) }), {
        transient: true,
      });
      const Seen = ContextFold.of('seen')
        .initial(() => 0)
        .on(Secret, (count) => count + 1);
      const reader = AgentFactory.run()
        .listensTo([start])
        .folds([Seen])
        .logic(async () => {})
        .produce({});

      const errors = redactedErrors(({ mainChannel, registerAgent }) => {
        mainChannel.events([start, Marked]);
        registerAgent(reader).subscribe(mainChannel);
      });

      expect(errors.map((error) => [error.event, error.message.split('Defined by: ')[1]])).toEqual([
        ['marked', 'channel "main"'],
        ['secret', 'handled by fold "seen"'],
      ]);
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
    expectTypeOf<WiringErrorCode>().toEqualTypeOf<
      | 'emit-not-accepted'
      | 'listen-not-accepted'
      | 'fold-checkpoint-shared'
      | 'durable-event-redacted'
    >();
    expectTypeOf<WiringWarningCode>().toEqualTypeOf<
      | 'unconsumed-event'
      | 'agent-publishes-nowhere'
      | 'agent-not-subscribed'
      | 'agent-unreachable'
      | 'terminal-event-not-emitted'
      | 'fold-event-unpublished'
      | 'fold-name-shared'
      | 'event-schema-mismatch'
      | 'event-not-storable'
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
