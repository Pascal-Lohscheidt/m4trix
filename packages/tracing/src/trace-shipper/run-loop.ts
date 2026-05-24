import { replicateOnce } from './replicate-once.js';
import type { ReplicateOnceResult, TraceShipperDeps } from './types.js';

export type RunLoopOptions = {
  intervalMs: number;
  once?: boolean;
  onTick?: (result: ReplicateOnceResult) => void;
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
  const tick = async (): Promise<ReplicateOnceResult> => {
    const result = await replicateOnce(deps);
    options.onTick?.(result);
    return result;
  };

  await tick();

  if (options.once) return;

  while (!options.signal?.aborted) {
    await sleep(options.intervalMs, options.signal);
    if (options.signal?.aborted) break;
    await tick();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
