export type ParsedTraceShipperCli = {
  root: string;
  interval: string;
  once: boolean;
  retain: string;
  retainRunning: string;
  keepShipped: boolean;
};

export class TraceShipperCliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceShipperCliParseError';
  }
}

export const DEFAULT_TRACE_ROOT = '/traces';
export const DEFAULT_INTERVAL = '2s';
export const DEFAULT_RETAIN = '5m';
export const DEFAULT_RETAIN_RUNNING = '24h';

export function parseTraceShipperCliArgs(argv: string[]): ParsedTraceShipperCli {
  const args = argv.slice(2);
  let root = process.env.TRACE_ROOT ?? DEFAULT_TRACE_ROOT;
  let interval = DEFAULT_INTERVAL;
  let once = false;
  let retain = DEFAULT_RETAIN;
  let retainRunning = DEFAULT_RETAIN_RUNNING;
  let keepShipped = false;

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
    if (a === '--retain') {
      const v = args[++i];
      if (!v) throw new TraceShipperCliParseError('--retain requires a value');
      retain = v;
      continue;
    }
    if (a === '--retain-running') {
      const v = args[++i];
      if (!v) throw new TraceShipperCliParseError('--retain-running requires a value');
      retainRunning = v;
      continue;
    }
    if (a === '--keep-shipped') {
      keepShipped = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      throw new TraceShipperCliParseError('HELP');
    }
    if (a.startsWith('-')) {
      throw new TraceShipperCliParseError(`Unknown flag "${a}"`);
    }
  }

  return { root, interval, once, retain, retainRunning, keepShipped };
}

export function traceShipperCliHelpText(program: string): string {
  return `
${program} — replicate local filesystem traces to S3 + DynamoDB

Usage:
  ${program} [--root <dir>] [--interval <duration>] [--once] [--retain <duration>]
             [--retain-running <duration>] [--keep-shipped]

Options:
  --root <dir>              Local trace root (default: TRACE_ROOT or ${DEFAULT_TRACE_ROOT})
  --interval <dur>          Poll interval, e.g. 500ms, 2s, 1m (default: ${DEFAULT_INTERVAL})
  --once                    Run one replication pass and exit
  --retain <dur>            Delete finished, fully shipped traces locally once idle
                            this long; 0 = right away (default: ${DEFAULT_RETAIN})
  --retain-running <dur>    Same for traces never marked finished, e.g. after an app
                            crash (default: ${DEFAULT_RETAIN_RUNNING})
  --keep-shipped            Never delete shipped traces from local disk
  -h, --help                Show this help

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
