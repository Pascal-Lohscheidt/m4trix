export const DEFAULT_PORT = 4320;

export type ParsedCli = {
  port: number;
  withLogs: boolean;
};

export class CliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliParseError';
  }
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const args = argv.slice(2);
  let port = DEFAULT_PORT;
  let withLogs = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--with-logs') {
      withLogs = true;
      continue;
    }
    if (arg === '--port') {
      const value = args[++i];
      if (!value) throw new CliParseError('--port requires a value');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new CliParseError(`Invalid --port "${value}"`);
      }
      port = parsed;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new CliParseError('HELP');
    }
    if (arg.startsWith('-')) {
      throw new CliParseError(`Unknown flag "${arg}"`);
    }
  }

  return { port, withLogs };
}

export function cliHelpText(program: string): string {
  return `
${program} — terminal assistant powered by @m4trix/core agent network

Usage:
  ${program} [--port <n>]

Options:
  --port <n>      HTTP port for the agent server (default: ${DEFAULT_PORT})
  --with-logs     Enable server/CLI logs and Node process warnings
  -h, --help      Show this help

The CLI spawns an agent server subprocess and opens an interactive chat session.
`.trim();
}
