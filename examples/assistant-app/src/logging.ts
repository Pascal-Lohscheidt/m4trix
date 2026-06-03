import { setMaxListeners } from 'node:events';

const DISABLE_MAX_LISTENERS_WARNING = '--disable-warning=MaxListenersExceededWarning';

/** Set by CLI/server when `--with-logs` is passed (ASSISTANT_WITH_LOGS=1). */
export function isVerboseLogging(): boolean {
  return process.env.ASSISTANT_WITH_LOGS === '1';
}

/** NODE_OPTIONS for child processes (must be set before Node starts). */
export function withQuietNodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (isVerboseLogging()) {
    return { ...base };
  }

  const existing = base.NODE_OPTIONS ?? '';
  if (existing.includes(DISABLE_MAX_LISTENERS_WARNING)) {
    return { ...base };
  }

  return {
    ...base,
    NODE_OPTIONS: existing
      ? `${existing} ${DISABLE_MAX_LISTENERS_WARNING}`
      : DISABLE_MAX_LISTENERS_WARNING,
  };
}

/**
 * Quiet mode: raise listener limits and disable MaxListeners stderr noise from
 * LangChain/fetch stacking abort listeners on AbortSignal.
 */
export function configureProcessLogging(): void {
  if (isVerboseLogging()) {
    return;
  }

  setMaxListeners(20);
  if (typeof AbortSignal !== 'undefined') {
    setMaxListeners(20, AbortSignal.prototype);
  }

  process.on('warning', (warning) => {
    if (warning.name === 'MaxListenersExceededWarning') {
      return;
    }
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

export function logInfo(message: string): void {
  if (isVerboseLogging()) {
    // eslint-disable-next-line no-console
    console.log(message);
  }
}
