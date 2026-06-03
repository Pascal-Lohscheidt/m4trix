import type { ExposedAPI } from '@m4trix/core/matrix';
import { network } from '../network/network.js';
import { MessageEvent } from '../network/events.js';
import {
  dependencyLayers,
  publishCommandApprovalResolved,
  registerActiveRun,
  startServerRuntime,
  unregisterActiveRun,
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
  exposedApi: ExposedAPI;
  registerActiveRun: typeof registerActiveRun;
  unregisterActiveRun: typeof unregisterActiveRun;
  publishCommandApprovalResolved: typeof publishCommandApprovalResolved;
};

export async function createAssistantContext(): Promise<AssistantContext> {
  const plane = await startServerRuntime();

  const exposedApi = network.expose({
    protocol: 'sse',
    plane,
    select: { channels: 'client' },
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
  });

  return {
    exposedApi,
    registerActiveRun,
    unregisterActiveRun,
    publishCommandApprovalResolved,
  };
}
