import { Effect, Queue } from 'effect';
import type { AgentNetwork } from '../agent-network/agent-network';
import type { ConfiguredChannel } from '../agent-network/channel';
import { createEventPlane, run } from '../agent-network/event-plane';
import type { Envelope } from '../agent-network/event-plane';
import { ChannelName, isHttpStreamSink } from '../agent-network/channel';
import type {
  ExposeOptions,
  ExposeRequest,
  ExposedAPI,
  ExposedStream,
  StreamFactory,
} from './types';

/** Extract JSON payload from ExposeRequest. POST with JSON body, or Express req.body, else {}. */
async function extractPayload(req: ExposeRequest): Promise<unknown> {
  const webRequest = req.request as Request | undefined;
  if (webRequest?.method === 'POST') {
    const ct = webRequest.headers?.get?.('content-type') ?? '';
    if (ct.includes('application/json')) {
      try {
        return await webRequest.json();
      } catch {
        return {};
      }
    }
  }
  const expressReq = req.req as { body?: unknown } | undefined;
  if (expressReq?.body != null) {
    return expressReq.body;
  }
  return {};
}

/** Resolve which channel(s) to subscribe to from select options */
function resolveChannels(
  network: AgentNetwork,
  select?: ExposeOptions['select'],
): ChannelName[] {
  const channels = network.getChannels();
  if (select?.channels) {
    const ch = select.channels;
    const arr = Array.isArray(ch) ? ch : [ch];
    return arr.map((c) => ChannelName(c as string));
  }
  // Prefer channels with http-stream sink (explicitly marked for frontend)
  const httpStreamChannels = [...channels.values()]
    .filter((ch) => ch.getSinks().some(isHttpStreamSink))
    .map((ch) => ch.name);
  if (httpStreamChannels.length > 0) return httpStreamChannels;
  // Fallback: prefer "client", else first channel
  const client = channels.get('client' as ChannelName);
  if (client) return [client.name];
  const first = channels.values().next().value;
  return first ? [first.name] : [];
}

/** Create async iterable from Queue.Dequeue, respecting AbortSignal */
function streamFromDequeue(
  take: () => Promise<Envelope>,
  signal?: AbortSignal | null,
  eventFilter?: string[],
): ExposedStream {
  const shouldInclude = (e: Envelope): boolean =>
    !eventFilter?.length || eventFilter.includes(e.name);

  return {
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Envelope> {
      while (!signal?.aborted) {
        const takePromise = take();
        const abortPromise = signal
          ? new Promise<never>((_, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            })
          : new Promise<never>(() => {});

        let envelope: Envelope;
        try {
          envelope = await Promise.race([takePromise, abortPromise]);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') break;
          throw e;
        }

        if (shouldInclude(envelope)) yield envelope;
      }
    },
  };
}

/**
 * Expose the agent network as a streamable API. Returns an ExposedAPI that
 * adapters (NextEndpoint, ExpressEndpoint) consume to produce SSE responses.
 *
 * @example
 * const api = agentNetwork.expose({ protocol: "sse", auth, select });
 * export const GET = NextEndpoint.from(api, { requestToContextId, requestToRunId }).handler();
 */
export function expose(
  network: AgentNetwork,
  options: ExposeOptions,
): ExposedAPI {
  const {
    auth,
    select,
    plane: providedPlane,
    onRequest,
    triggerEvents,
    tracingLayer,
  } = options;
  const triggerEventDef = triggerEvents?.[0];
  const triggerEventName = triggerEventDef?.name ?? 'request';
  const channels = resolveChannels(network, select);
  const eventFilter = select?.events;
  const mainChannel = network.getMainChannel();

  if (channels.length === 0) {
    throw new Error('expose: no channels to subscribe to');
  }

  const createStream = (async (
    req: ExposeRequest,
    consumer?: (stream: ExposedStream) => Promise<unknown>,
  ) => {
    const payload = await extractPayload(req);
    const signal = req.request?.signal;

    const program = Effect.gen(function* () {
      const plane =
        providedPlane ??
        (yield* createEventPlane({ network, store: network.getStore() }));
      if (!providedPlane) {
        const emitQueue = yield* Queue.unbounded<{
          channels: readonly ConfiguredChannel[];
          envelope: Envelope;
        }>();
        yield* Effect.fork(
          Effect.forever(
            Queue.take(emitQueue).pipe(
              Effect.flatMap(({ channels: chs, envelope }) =>
                plane.publishToChannels(chs, envelope),
              ),
            ),
          ),
        );
        yield* Effect.fork(run(network, plane, { emitQueue }));
        // Allow run() to subscribe agents before we publish (PubSub does not buffer for future subscribers)
        yield* Effect.sleep('10 millis');
      }

      const targetChannel = mainChannel?.name ?? channels[0]!;
      let runId = req.runId ?? crypto.randomUUID();
      let contextId = req.contextId ?? crypto.randomUUID();

      const setRunId = (id: string): void => {
        runId = id;
      };
      const setContextId = (id: string): void => {
        contextId = id;
      };

      const emitStartEvent = (opts: {
        contextId: string;
        runId: string;
        event: { name: string; payload: unknown };
      }): void => {
        const meta = {
          runId: opts.runId,
          contextId: opts.contextId,
        };
        const envelope: Envelope = {
          name: opts.event.name,
          meta,
          payload: opts.event.payload,
        };
        Effect.runPromise(plane.publish(targetChannel, envelope)).catch(
          () => {},
        );
      };

      // Subscribe to first channel before emitting (so we don't miss agent output)
      const dequeue = yield* plane.subscribe(channels[0]!);

      if (onRequest) {
        yield* Effect.tryPromise(() =>
          Promise.resolve(
            onRequest({
              setRunId,
              setContextId,
              emitStartEvent,
              req,
              payload,
            }),
          ),
        );
      } else if (!providedPlane) {
        const envelope: Envelope = {
          name: triggerEventName,
          meta: { runId, contextId },
          payload,
        };
        yield* plane.publish(targetChannel, envelope);
        yield* Effect.sleep('10 millis');
      }
      const take = (): Promise<Envelope> =>
        Effect.runPromise(Queue.take(dequeue)) as Promise<Envelope>;

      const stream = streamFromDequeue(take, signal ?? undefined, eventFilter);
      if (consumer) {
        return yield* Effect.tryPromise(() => consumer(stream));
      }
      return stream;
    });

    const runnable = tracingLayer
      ? program.pipe(Effect.provide(tracingLayer), Effect.scoped)
      : program.pipe(Effect.scoped);
    return Effect.runPromise(runnable);
  }) as StreamFactory;

  return {
    protocol: 'sse',
    createStream: (async (
      req: ExposeRequest,
      consumer?: (stream: ExposedStream) => Promise<unknown>,
    ) => {
      if (auth) {
        const result = await auth(req);
        if (!result.allowed) {
          throw new ExposeAuthError(
            result.message ?? 'Unauthorized',
            result.status ?? 401,
          );
        }
      }
      return consumer ? createStream(req, consumer) : createStream(req);
    }) as StreamFactory,
  };
}

/** Thrown when auth denies the request */
export class ExposeAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = 'ExposeAuthError';
  }
}
