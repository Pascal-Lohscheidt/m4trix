export type ParsedTraceShipperCli = {
  root: string;
  interval: string;
  once: boolean;
};

export class TraceShipperCliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceShipperCliParseError';
  }
}

export const DEFAULT_TRACE_ROOT = '/traces';
export const DEFAULT_INTERVAL = '2s';

export function parseTraceShipperCliArgs(argv: string[]): ParsedTraceShipperCli {
  const args = argv.slice(2);
  let root = process.env.TRACE_ROOT ?? DEFAULT_TRACE_ROOT;
  let interval = DEFAULT_INTERVAL;
  let once = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') {
      const v = args[++i];
      if (!v) throw new TraceShipperCliParseError('--root requires a value');
      root = v;
      continue;
    }
    if (a === '--interval') {
      const v = args[++i];
      if (!v) throw new TraceShipperCliParseError('--interval requires a value');
      interval = v;
      continue;
    }
    if (a === '--once') {
      once = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      throw new TraceShipperCliParseError('HELP');
    }
    if (a.startsWith('-')) {
      throw new TraceShipperCliParseError(`Unknown flag "${a}"`);
    }
  }

  return { root, interval, once };
}

export function traceShipperCliHelpText(program: string): string {
  return `
${program} — replicate local filesystem traces to S3 + DynamoDB

Usage:
  ${program} [--root <dir>] [--interval <duration>] [--once]

Options:
  --root <dir>       Local trace root (default: TRACE_ROOT or ${DEFAULT_TRACE_ROOT})
  --interval <dur>   Poll interval, e.g. 500ms, 2s, 1m (default: ${DEFAULT_INTERVAL})
  --once             Run one replication pass and exit
  -h, --help         Show this help

Environment:
  TRACE_DYNAMO_TABLE   DynamoDB table (required)
  TRACE_S3_BUCKET      S3 bucket for payloads (required)
  TRACE_S3_PREFIX      Optional S3 key prefix
  AWS_REGION           AWS region
  AWS_ENDPOINT_URL     Optional custom endpoint (e.g. LocalStack)
  TRACE_ROOT           Default --root when flag omitted

Examples:
  ${program} --root ./.traces --once
  ${program} --root /traces --interval 2s
`.trim();
}
