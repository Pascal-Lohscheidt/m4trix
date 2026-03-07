type LogLevel = 'log' | 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private static globalEnabled = false;

  constructor(private namespace: string = '') {}

  static enableGlobalLogging(): void {
    Logger.globalEnabled = true;
  }

  static disableGlobalLogging(): void {
    Logger.globalEnabled = false;
  }

  private formatPrefix(): string {
    return this.namespace ? `[${this.namespace}]` : '';
  }

  private logIfEnabled(level: LogLevel, ...args: unknown[]): void {
    if (!Logger.globalEnabled) return;

    const prefix = this.formatPrefix();
    if (prefix) {
      console[level](prefix, ...args);
    } else {
      console[level](...args);
    }
  }

  log(...args: unknown[]): void {
    this.logIfEnabled('log', ...args);
  }

  debug(...args: unknown[]): void {
    this.logIfEnabled('debug', ...args);
  }

  info(...args: unknown[]): void {
    this.logIfEnabled('info', ...args);
  }

  warn(...args: unknown[]): void {
    this.logIfEnabled('warn', ...args);
  }

  error(...args: unknown[]): void {
    this.logIfEnabled('error', ...args);
  }
}
