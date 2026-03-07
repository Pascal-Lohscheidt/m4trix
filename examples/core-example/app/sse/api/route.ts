import { NextEndpoint } from '@m4trix/core/matrix';
import { network } from './network';
import { MessageEvent } from './events';

const api = network.expose({
  protocol: 'sse',
  select: { channels: 'client' },
  triggerEvents: [MessageEvent],
  onRequest: ({ emitStartEvent, req, payload }) =>
    emitStartEvent({
      contextId: req.contextId ?? crypto.randomUUID(),
      runId: req.runId ?? crypto.randomUUID(),
      event: MessageEvent.make({
        message: (payload as { request?: string }).request ?? '',
        role: 'user',
      }),
    }),
});

const handler = NextEndpoint.from(api, {
  requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
  requestToRunId: () => crypto.randomUUID(),
}).handler();

export const GET = handler;
export const POST = handler;
