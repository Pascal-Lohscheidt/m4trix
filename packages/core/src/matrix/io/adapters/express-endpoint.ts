import type * as Duration from 'effect/Duration';
import { consoleNetworkLogger, type NetworkLogger, resolveLogger } from '../../logger.js';
import { ExposeAuthError, ExposeRunNotFoundError, ExposeValidationError } from '../expose.js';
import type { ExposedAPI } from '../types.js';
import { heartbeatMillis, pipeSSE } from './sse-writer.js';

/** Minimal Express-like request (compatible with express.Request) */
export type ExpressRequest = {
  on(event: 'close', fn: () => void): void;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Parsed query string (`req.query`): `?payload=` and `?lastEventId=` are read from it. */
  query?: Record<string, unknown>;
  originalUrl?: string;
  url?: string;
};

/** Options of `ExpressEndpoint.from()`. */
export type ExpressEndpointOptions = {
  /** The run's conversation id for a request. Default: a fresh id per request. */
  requestToContextId?: (req: ExpressRequest) => string;
  /** The run id for a request. Default: a fresh id per request. */
  requestToRunId?: (req: ExpressRequest) => string;
  /**
   * Interval of the heartbeat comment (`: ping`) that keeps idle streams open through proxies and
   * load balancers. Default `'15 seconds'`; `Infinity` disables it.
   */
  heartbeat?: Duration.DurationInput;
  /** Where stream failures are logged. Defaults to the network's logger (`logger` at setup). */
  logger?: NetworkLogger;
};

/** Minimal Express-like response (compatible with express.Response) */
export type ExpressResponse = {
  setHeader(name: string, value: string | number): void;
  flushHeaders?(): void;
  /** Returns `false` when the socket's buffer is full: the next write waits for `'drain'`. */
  write(chunk: Uint8Array): unknown;
  flush?(): void;
  end(): void;
  status(code: number): ExpressResponse;
  send(body: string): void;
  /** Set by Express once the response started. */
  headersSent?: boolean;
  once?(event: 'drain' | 'close', fn: () => void): unknown;
};

/** Express route handler signature; `next` receives errors from before the stream started. */
export type ExpressHandler = (
  req: ExpressRequest,
  res: ExpressResponse,
  next?: (error?: unknown) => void,
) => void | Promise<void>;

/** The first value of a header or query parameter. */
const first = (value: unknown): string | undefined => {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v !== '' ? v : undefined;
};

/** The resume position of a reconnect: `Last-Event-ID`, else `?lastEventId=`. */
function lastEventIdOf(req: ExpressRequest): string | undefined {
  const header = first(req.headers?.['last-event-id']);
  if (header) return header;
  const query = first(req.query?.lastEventId);
  if (query) return query;
  const url = req.originalUrl ?? req.url;
  if (!url) return undefined;
  try {
    return new URL(url, 'http://localhost').searchParams.get('lastEventId') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adapter for Express. Maps an ExposedAPI to an Express route handler
 * that streams events as SSE.
 *
 * Every durable event carries an SSE `id:`; a reconnect with `Last-Event-ID` (or
 * `?lastEventId=`) resumes the run instead of starting one (see `registerSSEStream`). Writes wait
 * for `'drain'` when the socket is full, and the handler never rejects: errors before the stream
 * started go to `next` (a 500 without it), errors after it end the stream with
 * `m4trix:run.failed` (kind `stream-error`).
 *
 * @example
 * const api = agentNetwork.expose(registerSSEStream({ channel: 'client', auth }));
 * app.get("/events", ExpressEndpoint.from(api, {
 *   requestToContextId: (req) => req.headers?.['x-correlation-id'] ?? crypto.randomUUID(),
 *   requestToRunId: () => crypto.randomUUID(),
 * }).handler());
 */
export const ExpressEndpoint = {
  from(
    api: ExposedAPI,
    options: ExpressEndpointOptions = {},
  ): {
    handler(): ExpressHandler;
  } {
    if (api.protocol !== 'sse') {
      throw new Error(`ExpressEndpoint: unsupported protocol "${api.protocol}"`);
    }

    const {
      requestToContextId = (): string => crypto.randomUUID(),
      requestToRunId = (): string => crypto.randomUUID(),
    } = options;
    const heartbeatMs = heartbeatMillis(options.heartbeat);
    const logger = resolveLogger(options.logger ?? api.logger ?? consoleNetworkLogger);

    return {
      handler(): ExpressHandler {
        return async (req, res, next) => {
          const controller = new AbortController();
          req.on('close', () => controller.abort());

          const lastEventId = lastEventIdOf(req);
          const exposeReq = {
            request: { signal: controller.signal } as Request,
            req,
            res,
            contextId: requestToContextId(req),
            runId: requestToRunId(req),
            ...(lastEventId !== undefined && { lastEventId }),
          };

          let streaming = false;
          const encoder = new TextEncoder();
          /** Resolves once `res` took the chunk, after `'drain'` when its buffer was full. */
          const write = (text: string): Promise<void> => {
            if (controller.signal.aborted) return Promise.resolve();
            const accepted = res.write(encoder.encode(text));
            res.flush?.();
            if (accepted !== false || !res.once) return Promise.resolve();
            return new Promise<void>((resolve) => {
              const done = (): void => {
                controller.signal.removeEventListener('abort', done);
                resolve();
              };
              res.once?.('drain', done);
              controller.signal.addEventListener('abort', done, { once: true });
            });
          };

          try {
            await api.createStream(exposeReq, async (stream) => {
              // Set SSE headers only after auth has passed
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              // Tells nginx (and proxies that follow it) not to buffer the stream.
              res.setHeader('X-Accel-Buffering', 'no');
              res.flushHeaders?.();
              streaming = true;

              try {
                await pipeSSE(stream, write, {
                  heartbeatMs,
                  logger,
                  signal: controller.signal,
                  meta: { runId: exposeReq.runId, contextId: exposeReq.contextId },
                });
              } finally {
                res.end();
              }
            });
          } catch (e) {
            if (e instanceof ExposeAuthError) {
              res.status(e.status).send(e.message);
              return;
            }
            if (e instanceof ExposeValidationError || e instanceof ExposeRunNotFoundError) {
              res.setHeader('Content-Type', 'application/json');
              res.status(e.status).send(JSON.stringify(e.toJSON()));
              return;
            }
            // Never rethrown: an async handler's rejection would go unhandled in Express 4.
            if (streaming || res.headersSent) {
              logger.error('[m4trix] SSE request failed after the response started:', e);
              return;
            }
            if (next) {
              next(e);
              return;
            }
            logger.error('[m4trix] SSE request failed:', e);
            res.status(500).send('Internal Server Error');
          }
        };
      },
    };
  },
};
