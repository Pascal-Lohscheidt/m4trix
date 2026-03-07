import type { ExposedAPI } from '../types';
import { ExposeAuthError } from '../expose';
import { formatSSE } from '../protocols/sse';

/** Next.js App Router GET/POST handler signature */
export type NextGetHandler = (request: Request) => Promise<Response>;

/** Options for NextEndpoint.from() - required to define how request maps to contextId and runId */
export type NextEndpointOptions = {
  requestToContextId: (request: Request) => string;
  requestToRunId: (request: Request) => string;
};

/**
 * Adapter for Next.js App Router. Maps an ExposedAPI to a route handler
 * that streams events as SSE. Use for both GET and POST; POST with JSON body
 * is recommended for passing the start event payload.
 *
 * @example
 * const api = agentNetwork.expose({ protocol: "sse", auth, select });
 * const handler = NextEndpoint.from(api, {
 *   requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
 *   requestToRunId: () => crypto.randomUUID(),
 * }).handler();
 * export const GET = handler;
 * export const POST = handler;
 */
export const NextEndpoint = {
  from(api: ExposedAPI, options: NextEndpointOptions): {
    handler(): NextGetHandler;
  } {
    if (api.protocol !== 'sse') {
      throw new Error(`NextEndpoint: unsupported protocol "${api.protocol}"`);
    }

    const { requestToContextId, requestToRunId } = options;

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
            const { readable, writable } =
              new TransformStream<Uint8Array>();

            // Signal that the consumer callback has been entered (auth passed, stream ready)
            let consumerStarted!: () => void;
            const started = new Promise<void>((resolve) => {
              consumerStarted = resolve;
            });

            const streamDone = api.createStream(req, async (stream) => {
              consumerStarted();
              const writer = writable.getWriter();
              try {
                for await (const envelope of stream) {
                  if (request.signal?.aborted) break;
                  await writer.write(encoder.encode(formatSSE(envelope)));
                }
              } finally {
                await writer.close();
              }
            });

            // Race: consumer starts (auth passed) vs. createStream rejects (auth failed)
            await Promise.race([started, streamDone]);

            // Auth passed. Stream is being written in the background.
            streamDone.catch(() => {}); // prevent unhandled rejection

            return new Response(readable, {
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              },
            });
          } catch (e) {
            if (e instanceof ExposeAuthError) {
              return new Response(e.message, { status: e.status });
            }
            throw e;
          }
        };
      },
    };
  },
};
