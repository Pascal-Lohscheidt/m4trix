import type { ExposedAPI } from '@m4trix/core/matrix';
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

  const runPromise = exposedApi.createStream(
    {
      contextId: input.contextId,
      runId: input.runId,
      request: new Request('http://assistant.local/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: input.message }),
      }),
    },
    async (stream) => {
      try {
        for await (const envelope of stream) {
          await writer.write({
            kind: 'event',
            value: {
              name: envelope.name,
              payload: envelope.payload,
              meta: envelope.meta,
            },
          });

          if (envelope.name === 'message') break;
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
    reader.releaseLock();
  }
}
