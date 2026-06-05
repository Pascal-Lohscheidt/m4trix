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
