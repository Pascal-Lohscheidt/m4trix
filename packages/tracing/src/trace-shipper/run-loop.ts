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

export function parseIntervalMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid interval "${value}" (expected e.g. 500ms, 2s, 1m)`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid interval "${value}"`);
  }

  const unit = (match[2] ?? 's').toLowerCase();
  switch (unit) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60_000;
    default:
      return amount * 1000;
  }
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
