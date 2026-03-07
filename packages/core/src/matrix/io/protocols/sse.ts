import type { Envelope } from '../../agent-network/event-plane';

/** Format a single SSE message (event + data) */
export function formatSSE(envelope: Envelope): string {
  const data = JSON.stringify(envelope);
  return `event: ${envelope.name}\ndata: ${data}\n\n`;
}

/** Create a ReadableStream that encodes envelopes as SSE */
export function toSSEStream(
  source: AsyncIterable<Envelope>,
  signal?: AbortSignal | null,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const onAbort = (): void => controller.close();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const envelope of source) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(formatSSE(envelope)));
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        controller.close();
      }
    },
  });
}
