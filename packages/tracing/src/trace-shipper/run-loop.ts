import { replicateOnce } from './replicate-once.js';
import type { ReplicateOnceResult, TraceShipperDeps } from './types.js';

export type RunLoopOptions = {
  intervalMs: number;
  /** Run a single pass; a failing pass rejects instead of being reported to `onError`. */
  once?: boolean;
  onTick?: (result: ReplicateOnceResult) => void;
  /** Called when a whole pass fails (e.g. the root is unreadable); the loop keeps polling. */
  onError?: (error: unknown) => void;
  /** Stops polling; one final pass then ships whatever was written during shutdown. */
  signal?: AbortSignal;
};

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Parses a poll interval such as `500ms`, `2s`, `1m` or `1h` (seconds when no unit); must be > 0. */
export function parseIntervalMs(value: string): number {
  const ms = parseDuration(value);
  if (ms === undefined || ms <= 0) {
    throw new Error(`Invalid interval "${value}" (expected e.g. 500ms, 2s, 1m)`);
  }
  return ms;
}

/** Like `parseIntervalMs`, but `0` is allowed (for "right away"). */
export function parseDurationMs(value: string): number {
  const ms = parseDuration(value);
  if (ms === undefined) {
    throw new Error(`Invalid duration "${value}" (expected e.g. 0, 30s, 5m, 24h)`);
  }
  return ms;
}

function parseDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[(match[2] ?? 's').toLowerCase()];
}

export async function runShipperLoop(
  deps: TraceShipperDeps,
  options: RunLoopOptions,
): Promise<void> {
  const tick = async (): Promise<void> => {
    const result = await replicateOnce(deps);
    options.onTick?.(result);
  };

  if (options.once) {
    await tick();
    return;
  }

  const tickReportingErrors = async (): Promise<void> => {
    try {
      await tick();
    } catch (error) {
      options.onError?.(error);
    }
  };

  await tickReportingErrors();
  while (!options.signal?.aborted) {
    await sleep(options.intervalMs, options.signal);
    if (options.signal?.aborted) break;
    await tickReportingErrors();
  }
  await tickReportingErrors();
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
