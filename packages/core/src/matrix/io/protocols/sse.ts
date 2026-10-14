import type { Envelope } from '../../agent-network/event-plane.js';
import { consoleNetworkLogger, type NetworkLogger } from '../../logger.js';

/** An SSE comment line: keeps idle connections open through proxies and load balancers. */
export const SSE_HEARTBEAT = ': ping\n\n';

export type FormatSSEOptions = {
  /** The message's `id:` (its resume position, see `ExposedStream.idOf`). */
  readonly id?: string;
  /** Told when a payload is not JSON-serializable. Defaults to `console`. */
  readonly logger?: Pick<NetworkLogger, 'warn'>;
};

/** A field value on one line: CR, LF and NUL would end the field or the message. */
const singleLine = (value: string): string => value.replace(/[\r\n\0]/g, ' ');

/** JSON of `value` with BigInts as strings and repeated (e.g. cyclic) objects cut. */
function lossyJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

/**
 * The SSE `data:` of `envelope`: its JSON, or, for a payload JSON cannot serialize (BigInt,
 * cycles, a throwing `toJSON`), a lossy copy or an error marker, logged as a warning. Never
 * throws, so one bad payload cannot end a stream.
 */
function envelopeData(envelope: Envelope, logger: Pick<NetworkLogger, 'warn'>): string {
  try {
    return JSON.stringify(envelope);
  } catch (error) {
    logger.warn(
      `[m4trix] SSE payload of ${envelope.name} is not JSON-serializable; sent a lossy copy`,
      {
        event: envelope.name,
        runId: envelope.meta?.runId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  try {
    return lossyJson(envelope);
  } catch {
    return lossyJson({
      name: envelope.name,
      meta: envelope.meta,
      payload: { error: 'unserializable-payload' },
    });
  }
}

/**
 * Formats one SSE message: `id:` (when given), `event:` and `data:` (the envelope as JSON). Field
 * values are kept on one line, so an event name cannot inject fields; see `envelopeData` for
 * payloads JSON cannot serialize.
 */
export function formatSSE(envelope: Envelope, options: FormatSSEOptions = {}): string {
  const data = envelopeData(envelope, options.logger ?? consoleNetworkLogger);
  const id = options.id === undefined ? '' : `id: ${singleLine(options.id)}\n`;
  return `${id}event: ${singleLine(envelope.name)}\ndata: ${data}\n\n`;
}

/** Create a ReadableStream that encodes envelopes as SSE */
export function toSSEStream(
  source: AsyncIterable<Envelope>,
  signal?: AbortSignal | null,
  options: Pick<FormatSSEOptions, 'logger'> & {
    /** The SSE id of each envelope (see `ExposedStream.idOf`). */
    readonly idOf?: (envelope: Envelope) => string | undefined;
  } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const idOf = options.idOf ?? (source as { idOf?: (e: Envelope) => string | undefined }).idOf;

  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      const onAbort = (): void => controller.close();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        for await (const envelope of source) {
          if (signal?.aborted) break;
          controller.enqueue(
            encoder.encode(formatSSE(envelope, { id: idOf?.(envelope), logger: options.logger })),
          );
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        controller.close();
      }
    },
  });
}
