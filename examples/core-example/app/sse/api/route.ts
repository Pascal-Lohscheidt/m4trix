import { NextEndpoint, registerSSEStream } from '@m4trix/core/matrix';
import { network } from './network';
import { MessageEvent } from './events';

const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [MessageEvent],
    // The contextId comes from the client (x-correlation-id below), so history is namespaced by
    // the principal auth returns: a client only reaches its own principal's conversations. This
    // demo has no login, so every request is anonymous and shares one namespace (anyone who knows
    // a correlation id reads that conversation). With sessions, return the user instead:
    //   return { allowed: true, principal: { id: session.userId } };
    auth: async () => ({ allowed: true }),
    onRequest: ({ emitStartEvent, req, payload }) =>
      emitStartEvent({
        contextId: req.contextId ?? crypto.randomUUID(),
        runId: req.runId ?? crypto.randomUUID(),
        event: MessageEvent.make({
          message: (payload as { request?: string }).request ?? '',
          role: 'user',
        }),
      }),
  }),
);

const handler = NextEndpoint.from(api, {
  requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
  requestToRunId: () => crypto.randomUUID(),
}).handler();

export const GET = handler;
export const POST = handler;
