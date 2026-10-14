import { registerSSEStream, type InteractiveProxyHandle } from '@m4trix/core/matrix';
import { network } from '../network/network.js';
import { MessageEvent } from '../network/events.js';
import {
  dependencyLayers,
  startServerRuntime,
} from './assistant-runtime.js';

export type AgentEventChunk = {
  name: string;
  payload: unknown;
  meta: {
    runId: string;
    contextId: string;
    correlationId?: string;
    causationId?: string;
    ts?: number;
  };
};

export type AssistantContext = {
  proxyHandle: InteractiveProxyHandle;
};

export async function createAssistantContext(): Promise<AssistantContext> {
  const plane = await startServerRuntime();

  const proxyHandle = network.expose(
    registerSSEStream({
      channel: 'client',
      plane,
      triggerEvents: [MessageEvent],
      layers: dependencyLayers,
      // A command approval waits (up to 10 minutes) inside the assistant's in-flight tool call,
      // which never counts as idle, so the default idleTimeout (60s of no agent work and no
      // events) is enough. maxDuration still bounds a turn that hangs.
      maxDuration: '1 hour',
      // No `auth`: a local single-user app, so every run is anonymous. A multi-user server returns
      // `{ allowed: true, principal: { id: userId } }` from `auth` to keep each user's history apart.
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

  return {
    proxyHandle,
  };
}
