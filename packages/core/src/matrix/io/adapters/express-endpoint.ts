import type { ExposedAPI } from '../types';
import { ExposeAuthError } from '../expose';
import { formatSSE } from '../protocols/sse';

/** Minimal Express-like request (compatible with express.Request) */
export type ExpressRequest = {
  on(event: 'close', fn: () => void): void;
};

/** Options for ExpressEndpoint.from() - required to define how request maps to contextId and runId */
export type ExpressEndpointOptions = {
  requestToContextId: (req: ExpressRequest) => string;
  requestToRunId: (req: ExpressRequest) => string;
};

/** Minimal Express-like response (compatible with express.Response) */
export type ExpressResponse = {
  setHeader(name: string, value: string | number): void;
  flushHeaders?(): void;
  write(chunk: Uint8Array): void;
  flush?(): void;
  end(): void;
  status(code: number): ExpressResponse;
  send(body: string): void;
};

/** Express route handler signature */
export type ExpressHandler = (
  req: ExpressRequest,
  res: ExpressResponse,
) => void | Promise<void>;

/**
 * Adapter for Express. Maps an ExposedAPI to an Express route handler
 * that streams events as SSE.
 *
 * @example
 * const api = agentNetwork.expose({ protocol: "sse", auth, select });
 * app.get("/events", ExpressEndpoint.from(api, {
 *   requestToContextId: (req) => req.headers?.['x-correlation-id'] ?? crypto.randomUUID(),
 *   requestToRunId: () => crypto.randomUUID(),
 * }).handler());
 */
export const ExpressEndpoint = {
  from(api: ExposedAPI, options: ExpressEndpointOptions): {
    handler(): ExpressHandler;
  } {
    if (api.protocol !== 'sse') {
      throw new Error(
        `ExpressEndpoint: unsupported protocol "${api.protocol}"`,
      );
    }

    const { requestToContextId, requestToRunId } = options;

    return {
      handler(): ExpressHandler {
        return async (req: ExpressRequest, res: ExpressResponse) => {
          const controller = new AbortController();
          req.on('close', () => controller.abort());

          const exposeReq = {
            request: { signal: controller.signal } as Request,
            req,
            res,
            contextId: requestToContextId(req),
            runId: requestToRunId(req),
          };

          try {
            const encoder = new TextEncoder();
            await api.createStream(exposeReq, async (stream) => {
              // Set SSE headers only after auth has passed
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.flushHeaders?.();

              try {
                for await (const envelope of stream) {
                  if (controller.signal.aborted) break;
                  res.write(encoder.encode(formatSSE(envelope)));
                  res.flush?.();
                }
              } finally {
                res.end();
              }
            });
          } catch (e) {
            if (e instanceof ExposeAuthError) {
              res.status(e.status).send(e.message);
              return;
            }
            throw e;
          }
        };
      },
    };
  },
};
