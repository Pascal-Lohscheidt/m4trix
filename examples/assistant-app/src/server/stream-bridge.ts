import {
  type ExposedAPI,
  isRunEndEnvelope,
  isRunLifecycleEnvelope,
  RunLifecycleEvent,
} from '@m4trix/core/matrix';
import type { AgentEventChunk } from './context.js';

export async function* streamAgentEvents(
  exposedApi: ExposedAPI,
  input: { message: string; contextId: string; runId: string },
): AsyncGenerator<AgentEventChunk> {
  type QueueItem =
    | { kind: 'event'; value: AgentEventChunk }
    | { kind: 'done' }
    | { kind: 'error'; error: unknown };

  const { readable, writable } = new TransformStream<QueueItem>();
  const writer = writable.getWriter();
  // Aborted when the tRPC consumer goes away mid-run, which cancels the run and its agents.
  const controller = new AbortController();

  const runPromise = exposedApi.createStream(
    {
      contextId: input.contextId,
      runId: input.runId,
      request: new Request('http://assistant.local/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: input.message }),
        signal: controller.signal,
      }),
    },
    async (stream) => {
      try {
        // The stream ends by itself once the run ends (the network declares `endsOn`).
        for await (const envelope of stream) {
          if (isRunEndEnvelope(envelope) && envelope.name === RunLifecycleEvent.failed) {
            const { error } = envelope.payload;
            throw new Error(`Assistant run failed (${error.kind}): ${error.message}`);
          }
          if (isRunLifecycleEnvelope(envelope)) continue;

          await writer.write({
            kind: 'event',
            value: {
              name: envelope.name,
              payload: envelope.payload,
              meta: envelope.meta,
            },
          });
        }
        await writer.write({ kind: 'done' });
      } catch (error) {
        await writer.write({ kind: 'error', error });
      } finally {
        await writer.close();
      }
    },
  );

  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.kind === 'error') throw value.error;
      if (value.kind === 'done') break;
      yield value.value;
    }
    await runPromise;
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}
