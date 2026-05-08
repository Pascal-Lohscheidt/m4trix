export type AdapterKind = 'fs' | 'aws-stack';

export type ParsedCli = {
  adapter: AdapterKind;
  /** Resolved absolute or cwd-relative path for fs adapter */
  path: string | undefined;
  port: number;
};

export const DEFAULT_PORT = 4319;
export const DEFAULT_FS_RELATIVE_PATH = 'tmp/tracing-example';

export class CliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliParseError';
  }
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const args = argv.slice(2);
  let adapter: AdapterKind = 'fs';
  let path: string | undefined = DEFAULT_FS_RELATIVE_PATH;
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--adapter') {
      const v = args[++i];
      if (!v) throw new CliParseError('--adapter requires a value (fs | aws-stack)');
      if (v !== 'fs' && v !== 'aws-stack') {
        throw new CliParseError(`Invalid --adapter "${v}" (expected fs | aws-stack)`);
      }
      adapter = v;
      continue;
    }
    if (a === '--path') {
      const v = args[++i];
      if (!v) throw new CliParseError('--path requires a value');
      path = v;
      continue;
    }
    if (a === '--port') {
      const v = args[++i];
      if (!v) throw new CliParseError('--port requires a value');
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new CliParseError(`Invalid --port "${v}"`);
      }
      port = n;
      continue;
    }
    if (a === '--help' || a === '-h') {
      throw new CliParseError('HELP');
    }
    if (a.startsWith('-')) {
      throw new CliParseError(`Unknown flag "${a}"`);
    }
  }

  if (adapter === 'aws-stack') {
    path = undefined;
  } else if (!path) {
    path = DEFAULT_FS_RELATIVE_PATH;
  }

  return { adapter, path, port };
}

export function cliHelpText(program: string): string {
  return `
${program} — local trace viewer (filesystem traces)

Usage:
  ${program} [--adapter fs|aws-stack] [--path <dir>] [--port <n>]

Options:
  --adapter fs|aws-stack   Storage backend (default: fs)
  --path <dir>             Trace root for fs adapter (default: ${DEFAULT_FS_RELATIVE_PATH})
  --port <n>               HTTP port (default: ${DEFAULT_PORT})
  -h, --help               Show this help

Examples:
  ${program} --adapter fs --path ./tmp/tracing-example --port ${DEFAULT_PORT}
`.trim();
}
