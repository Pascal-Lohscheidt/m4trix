import type * as Duration from 'effect/Duration';
import { consoleNetworkLogger, type NetworkLogger, resolveLogger } from '../../logger.js';
import { ExposeAuthError, ExposeRunNotFoundError, ExposeValidationError } from '../expose.js';
import type { ExposedAPI } from '../types.js';
import { heartbeatMillis, pipeSSE } from './sse-writer.js';

/** Next.js App Router GET/POST handler signature */
export type NextGetHandler = (request: Request) => Promise<Response>;

/** Options of `NextEndpoint.from()`. */
export type NextEndpointOptions = {
  /** The run's conversation id for a request. Default: a fresh id per request. */
  requestToContextId?: (request: Request) => string;
  /** The run id for a request. Default: a fresh id per request. */
  requestToRunId?: (request: Request) => string;
  /**
   * Interval of the heartbeat comment (`: ping`) that keeps idle streams open through proxies and
   * load balancers. Default `'15 seconds'`; `Infinity` disables it.
   */
  heartbeat?: Duration.DurationInput;
  /** Where stream failures are logged. Defaults to the network's logger (`logger` at setup). */
  logger?: NetworkLogger;
};

/** Response headers of an SSE stream. */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  // Tells nginx (and proxies that follow it) not to buffer the stream.
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Adapter for Next.js App Router. Maps an ExposedAPI to a route handler
 * that streams events as SSE. Use for both GET and POST; POST with JSON body
 * is recommended for passing the start event payload (GET takes it as `?payload=`).
 *
 * Every durable event carries an SSE `id:`; a reconnect with `Last-Event-ID` (or
 * `?lastEventId=`) resumes the run instead of starting one (see `registerSSEStream`).
 *
 * @example
 * const api = agentNetwork.expose(registerSSEStream({ channel: 'client', auth }));
 * const handler = NextEndpoint.from(api, {
 *   requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
 *   requestToRunId: () => crypto.randomUUID(),
 * }).handler();
 * export const GET = handler;
 * export const POST = handler;
 */
export const NextEndpoint = {
  from(
    api: ExposedAPI,
    options: NextEndpointOptions = {},
  ): {
    handler(): NextGetHandler;
  } {
    if (api.protocol !== 'sse') {
      throw new Error(`NextEndpoint: unsupported protocol "${api.protocol}"`);
    }

    const {
      requestToContextId = (): string => crypto.randomUUID(),
      requestToRunId = (): string => crypto.randomUUID(),
    } = options;
    const heartbeatMs = heartbeatMillis(options.heartbeat);
    const logger = resolveLogger(options.logger ?? api.logger ?? consoleNetworkLogger);

    return {
      handler(): NextGetHandler {
        return async (request: Request) => {
          const req = {
            request,
            contextId: requestToContextId(request),
            runId: requestToRunId(request),
          };

          try {
            const encoder = new TextEncoder();
            const { readable, writable } = new TransformStream<Uint8Array>();

            // Signal that the consumer callback has been entered (auth passed, stream ready)
            let consumerStarted!: () => void;
            const started = new Promise<void>((resolve) => {
              consumerStarted = resolve;
            });

            const streamDone = api.createStream(req, async (stream) => {
              consumerStarted();
              const writer = writable.getWriter();
              try {
                await pipeSSE(stream, (text) => writer.write(encoder.encode(text)), {
                  heartbeatMs,
                  logger,
                  signal: request.signal,
                  meta: { runId: req.runId, contextId: req.contextId },
                });
              } finally {
                // Closing fails once the client cancelled the response: nothing left to close.
                await writer.close().catch(() => {});
              }
            });

            // Race: consumer starts (auth passed) vs. createStream rejects (auth failed)
            await Promise.race([started, streamDone]);

            // Auth passed. Stream is being written in the background; a failure from here on
            // cannot change the response any more.
            streamDone.catch((error: unknown) => {
              logger.error('[m4trix] SSE request failed after the response started:', error);
            });

            return new Response(readable, { headers: SSE_HEADERS });
          } catch (e) {
            if (e instanceof ExposeAuthError) {
              return new Response(e.message, { status: e.status });
            }
            if (e instanceof ExposeValidationError || e instanceof ExposeRunNotFoundError) {
              return Response.json(e.toJSON(), { status: e.status });
            }
            throw e;
          }
        };
      },
    };
  },
};
