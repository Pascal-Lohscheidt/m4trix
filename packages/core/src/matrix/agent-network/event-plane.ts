import { Cause, Effect, Fiber, PubSub, Queue, Scope } from 'effect';
import type { AgentNetwork, AnyAgent } from './agent-network';
import type {
  ContextEvents,
  EventMeta,
  RunEvents,
} from './agent-network-event';
import type { ChannelName, ConfiguredChannel } from './channel';
import type { AgentNetworkStore } from './stores/agent-network-store';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store';

/* ─── Envelope ─── */

export type Envelope = {
  name: string;
  meta: EventMeta;
  payload: unknown;
};

/* ─── EventPlane ─── */

export type EventPlane = {
  readonly publish: (
    channel: ChannelName,
    envelope: Envelope,
  ) => Effect.Effect<boolean>;
  readonly publishToChannels: (
    channels: readonly ConfiguredChannel[],
    envelope: Envelope,
  ) => Effect.Effect<boolean>;
  readonly subscribe: (
    channel: ChannelName,
  ) => Effect.Effect<Queue.Dequeue<Envelope>, never, Scope.Scope>;
  readonly getRunEvents: (runId: string, contextId: string) => RunEvents;
  readonly getContextEvents: (contextId: string) => ContextEvents;
  readonly shutdown: Effect.Effect<void>;
};

/* ─── Create EventPlane ─── */

const DEFAULT_CAPACITY = 16;

type CreateEventPlaneOptions = {
  network: AgentNetwork;
  capacity?: number;
  store?: AgentNetworkStore<Envelope>;
};

/**
 * Creates an EventPlane from an AgentNetwork. One PubSub per channel with
 * bounded back-pressure. Use `Effect.scoped` when running to ensure proper
 * cleanup.
 */
export const createEventPlane = (
  options: CreateEventPlaneOptions,
): Effect.Effect<EventPlane> =>
  Effect.gen(function* () {
    const {
      network,
      capacity = DEFAULT_CAPACITY,
      store = createInMemoryNetworkStore<Envelope>(),
    } = options;

    const channels = network.getChannels();
    const pubsubs = new Map<ChannelName, PubSub.PubSub<Envelope>>();

    for (const channel of channels.values()) {
      const pubsub = yield* PubSub.bounded<Envelope>(capacity);
      pubsubs.set(channel.name, pubsub);
    }

    const getPubsub = (channel: ChannelName): PubSub.PubSub<Envelope> => {
      const p = pubsubs.get(channel);
      if (!p) throw new Error(`Channel not found: ${channel}`);
      return p;
    };

    const recordEvent = (envelope: Envelope): void => {
      const { contextId, runId } = envelope.meta;
      store.storeEvent(contextId, runId, envelope);
    };

    const publishToPubSub = (
      channel: ChannelName,
      envelope: Envelope,
    ): Effect.Effect<boolean> => PubSub.publish(getPubsub(channel), envelope);

    const publish = (
      channel: ChannelName,
      envelope: Envelope,
    ): Effect.Effect<boolean> =>
      Effect.sync(() => recordEvent(envelope)).pipe(
        Effect.flatMap(() => publishToPubSub(channel, envelope)),
        Effect.withSpan('event.publish', {
          attributes: {
            'event.name': envelope.name,
            'event.payload': payloadForSpan(envelope.payload),
            channel,
            runId: envelope.meta.runId,
            contextId: envelope.meta.contextId,
          },
        }),
      );

    const publishToChannels = (
      targetChannels: readonly ConfiguredChannel[],
      envelope: Envelope,
    ): Effect.Effect<boolean> =>
      Effect.sync(() => recordEvent(envelope)).pipe(
        Effect.flatMap(() =>
          Effect.all(
            targetChannels.map((c) => publishToPubSub(c.name, envelope)),
            { concurrency: 'unbounded' },
          ),
        ),
        Effect.map((results: readonly boolean[]) => results.every(Boolean)),
        Effect.withSpan('event.publish', {
          attributes: {
            'event.name': envelope.name,
            'event.payload': payloadForSpan(envelope.payload),
            runId: envelope.meta.runId,
            contextId: envelope.meta.contextId,
          },
        }),
      );

    const subscribe = (
      channel: ChannelName,
    ): Effect.Effect<Queue.Dequeue<Envelope>, never, Scope.Scope> =>
      PubSub.subscribe(getPubsub(channel));

    const getRunEvents = (runId: string, contextId: string): RunEvents => {
      return store.getEvents(contextId, runId).slice();
    };

    const getContextEvents = (contextId: string): ContextEvents => {
      const byRun = store.getContextEvents(contextId);
      const map = new Map<string, readonly Envelope[]>();
      const all: Envelope[] = [];
      for (const [runId, events] of byRun) {
        const readonlyEvents = events.slice();
        map.set(runId, readonlyEvents);
        all.push(...readonlyEvents);
      }
      return {
        all,
        byRun: (runId: string) => map.get(runId) ?? [],
        map,
      };
    };

    const shutdown = Effect.all([...pubsubs.values()].map(PubSub.shutdown), {
      concurrency: 'unbounded',
    }).pipe(Effect.asVoid);

    return {
      publish,
      publishToChannels,
      subscribe,
      getRunEvents,
      getContextEvents,
      shutdown,
    };
  });

/** Serialize payload for span attributes; truncate if too long */
function payloadForSpan(payload: unknown, maxLen = 500): string {
  try {
    const s = JSON.stringify(payload);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  } catch {
    return String(payload);
  }
}

/* ─── Run Subscriber Loop ─── */

/**
 * Runs a single agent's subscription loop on one channel. Takes messages from
 * the dequeue, invokes the agent with the envelope as triggerEvent when the
 * event name matches the agent's listensTo, and wires emit to publish to the
 * agent's output channels.
 */
type EmitQueue = Queue.Queue<{
  channels: readonly ConfiguredChannel[];
  envelope: Envelope;
}>;

export const runSubscriber = (
  agent: AnyAgent,
  publishesTo: readonly ConfiguredChannel[],
  dequeue: Queue.Dequeue<Envelope>,
  plane: EventPlane,
  emitQueue?: EmitQueue,
  channelName?: ChannelName,
): Effect.Effect<Fiber.RuntimeFiber<void, never>> =>
  Effect.gen(function* () {
    const listensTo = agent.getListensTo?.() ?? [];
    const agentId = agent.getId();

    const processOne = (): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const envelope = yield* Queue.take(dequeue);
        if (listensTo.length > 0 && !listensTo.includes(envelope.name)) {
          return;
        }
        const runEvents = plane.getRunEvents(
          envelope.meta.runId,
          envelope.meta.contextId,
        );
        const contextEvents = plane.getContextEvents(envelope.meta.contextId);
        yield* Effect.withSpan('agent.listen', {
          attributes: {
            agentId,
            'event.name': envelope.name,
            'event.payload': payloadForSpan(envelope.payload),
            ...(channelName !== undefined && { channel: channelName }),
          },
        })(
          Effect.withSpan('agent.invoke', {
            attributes: {
              agentId,
              'event.name': envelope.name,
              'event.payload': payloadForSpan(envelope.payload),
            },
          })(
            Effect.tryPromise({
              try: () =>
                agent.invoke({
                  triggerEvent: envelope,
                  emit: (userEvent: { name: string; payload: unknown }) => {
                    const fullEnvelope: Envelope = {
                      name: userEvent.name,
                      meta: envelope.meta,
                      payload: userEvent.payload,
                    };
                    if (emitQueue) {
                      Effect.runPromise(
                        Queue.offer(emitQueue, {
                          channels: publishesTo,
                          envelope: fullEnvelope,
                        }),
                      ).catch(() => {});
                    } else {
                      Effect.runFork(
                        plane.publishToChannels(publishesTo, fullEnvelope),
                      );
                    }
                  },
                  runEvents,
                  contextEvents,
                }),
              catch: (e: unknown) => e,
            }),
          ),
        );
      }).pipe(
        Effect.catchAllCause((cause: Cause.Cause<unknown>) =>
          Cause.isInterrupted(cause)
            ? Effect.void
            : Effect.sync(() => {
                console.error(`Agent ${agent.getId()} failed:`, cause);
              }).pipe(Effect.asVoid),
        ),
      );

    const loop = (): Effect.Effect<void, never, never> =>
      processOne().pipe(Effect.flatMap(() => loop()));

    return yield* Effect.fork(loop());
  });

/* ─── Run Network ─── */

export type RunOptions = {
  /** When provided, agent emits are queued and published by a drain fiber in the same Effect context. Use when run is forked from expose without a shared plane. */
  emitQueue?: EmitQueue;
};

/**
 * Runs the event plane: starts a subscriber loop for each (agent, channel)
 * pair. Runs until the scope ends (e.g. on interrupt). Use Effect.scoped
 * to ensure subscriptions are properly cleaned up.
 */
export const run = (
  network: AgentNetwork,
  plane: EventPlane,
  options?: RunOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const registrations = network.getAgentRegistrations();
    const emitQueue = options?.emitQueue;

    for (const reg of registrations.values()) {
      for (const channel of reg.subscribedTo) {
        const dequeue = yield* plane.subscribe(channel.name);
        yield* runSubscriber(
          reg.agent,
          reg.publishesTo,
          dequeue,
          plane,
          emitQueue,
          channel.name,
        );
      }
    }

    yield* Effect.never;
  });
