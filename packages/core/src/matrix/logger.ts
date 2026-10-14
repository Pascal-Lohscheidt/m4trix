/**
 * Where a network reports what it does not fail on: wiring smells, refused publishes, store and
 * tracer failures, stream errors. Only `warn` is required; `error` falls back to `warn`, and
 * `debug` / `info` are dropped when missing. `console`, pino, winston and most leveled loggers fit
 * as they are.
 */
export type NetworkLogger = {
  debug?(message: string, data?: unknown): void;
  info?(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error?(message: string, data?: unknown): void;
};

const toConsole =
  (write: (...args: unknown[]) => void) =>
  (message: string, data?: unknown): void => {
    if (data === undefined) write(message);
    else write(message, data);
  };

/** The default logger: `console.debug` / `info` / `warn` / `error`. */
export const consoleNetworkLogger: Required<NetworkLogger> = {
  debug: toConsole((...args) => console.debug(...args)),
  info: toConsole((...args) => console.info(...args)),
  warn: toConsole((...args) => console.warn(...args)),
  error: toConsole((...args) => console.error(...args)),
};

/**
 * @internal `logger` with every level, `error` falling back to `warn`. A logger that throws is
 * ignored for that call: logging never fails the network.
 */
export function resolveLogger(
  logger: NetworkLogger = consoleNetworkLogger,
): Required<NetworkLogger> {
  const call =
    (pick: (l: NetworkLogger) => NetworkLogger['warn'] | undefined) =>
    (message: string, data?: unknown): void => {
      const write = pick(logger);
      if (!write) return;
      try {
        if (data === undefined) write.call(logger, message);
        else write.call(logger, message, data);
      } catch {
        // A failing logger must not fail what it reports on.
      }
    };
  return {
    debug: call((l) => l.debug),
    info: call((l) => l.info),
    warn: call((l) => l.warn),
    error: call((l) => l.error ?? l.warn),
  };
}
