import * as Duration from 'effect/Duration';
import type { Envelope } from '../../agent-network/event-plane.js';
import { isRunEndEnvelope, streamFailedEnvelope } from '../../agent-network/run-lifecycle.js';
import type { NetworkLogger } from '../../logger.js';
import { formatSSE, SSE_HEARTBEAT } from '../protocols/sse.js';
import type { ExposedStream } from '../types.js';

/** Default interval of the SSE heartbeat comment (`: ping`). */
export const DEFAULT_SSE_HEARTBEAT = '15 seconds';

/** The heartbeat interval in milliseconds; `undefined` when disabled (`Infinity`). */
export function heartbeatMillis(
  heartbeat: Duration.DurationInput = DEFAULT_SSE_HEARTBEAT,
): number | undefined {
  const millis = Duration.toMillis(heartbeat);
  if (millis === Number.POSITIVE_INFINITY) return undefined;
  if (!(millis > 0)) {
    throw new Error(
      `SSE heartbeat must be a positive duration or Infinity, got ${String(heartbeat)}`,
    );
  }
  return millis;
}

/**
 * @internal Writes `stream` as SSE through `write` (which resolves once the transport took the
 * chunk: back-pressure): its start id first, then each event with its id, and a heartbeat comment
 * every `heartbeatMs` while no write is pending. Never throws: a failure while streaming is logged
 * and, unless the client is gone or the run already ended, the stream ends with a client-safe
 * `m4trix:run.failed` (kind `stream-error`).
 */
export async function pipeSSE(
  stream: ExposedStream,
  write: (text: string) => Promise<void>,
  options: {
    readonly heartbeatMs: number | undefined;
    readonly logger: Required<Pick<NetworkLogger, 'warn' | 'error'>>;
    readonly signal?: AbortSignal;
    /** The run the stream is about, until an event says otherwise (for the failure event). */
    readonly meta: { runId: string; contextId: string };
  },
): Promise<void> {
  const { heartbeatMs, logger, signal } = options;
  let meta = options.meta;
  let ended = false;
  let pending = 0;
  const send = async (text: string): Promise<void> => {
    pending++;
    try {
      await write(text);
    } finally {
      pending--;
    }
  };
  const heartbeat =
    heartbeatMs === undefined
      ? undefined
      : setInterval(() => {
          // Only on an idle connection: a pending write already shows the stream is alive.
          if (pending === 0) send(SSE_HEARTBEAT).catch(() => {});
        }, heartbeatMs);
  try {
    if (stream.startId !== undefined)
      await send(`id: ${stream.startId.replace(/[\r\n\0]/g, ' ')}\n\n`);
    for await (const envelope of stream as AsyncIterable<Envelope>) {
      if (signal?.aborted) break;
      meta = envelope.meta;
      await send(formatSSE(envelope, { id: stream.idOf?.(envelope), logger }));
      if (isRunEndEnvelope(envelope)) ended = true;
    }
  } catch (error) {
    // A client that went away is not a server failure.
    if (signal?.aborted) return;
    logger.error('[m4trix] SSE stream failed after the response started:', error);
    if (!ended) {
      await send(formatSSE(streamFailedEnvelope(meta), { logger })).catch(() => {});
    }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}
