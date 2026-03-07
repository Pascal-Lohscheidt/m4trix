export type SimpleCliCommand = 'run' | 'generate';

export interface SimpleCliArgs {
  command?: SimpleCliCommand;
  datasetName?: string;
  evaluatorPattern?: string;
  /** Max concurrent evaluations. Default: 4. Use 1 for sequential. */
  concurrency?: number;
  help: boolean;
  unknownArgs: string[];
}

/** Default concurrency for I/O-bound evals (e.g. LLM API calls). Node is single-threaded, so CPU count is not meaningful. */
export function getDefaultConcurrency(): number {
  return 4;
}

export function parseSimpleCliArgs(argv: string[]): SimpleCliArgs {
  const args: SimpleCliArgs = {
    help: false,
    unknownArgs: [],
  };
  let index = 0;
  if (argv[0] === 'run' || argv[0] === 'generate') {
    args.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if ((token === '--dataset' || token === '--datasetName') && argv[index + 1]) {
      args.datasetName = argv[index + 1];
      index += 1;
      continue;
    }
    if ((token === '--evaluator' || token === '--name') && argv[index + 1]) {
      args.evaluatorPattern = argv[index + 1];
      index += 1;
      continue;
    }
    if ((token === '--concurrency' || token === '-c') && argv[index + 1]) {
      const n = parseInt(argv[index + 1]!, 10);
      if (!Number.isNaN(n) && n >= 1) {
        args.concurrency = n;
      }
      index += 1;
      continue;
    }
    args.unknownArgs.push(token);
  }

  return args;
}

export function getSimpleCliUsage(): string {
  return [
    'Usage:',
    '  eval-agents-simple run --dataset <datasetName> --evaluator <name-or-pattern> [--concurrency N]',
    '  eval-agents-simple generate --dataset <datasetName>',
    '',
    'Options:',
    '  --concurrency, -c N   Max concurrent evaluations (default: 4). Use 1 for sequential.',
    '',
    'Pattern examples for --evaluator:',
    '  score-evaluator       exact name (case-insensitive)',
    '  "*score*"             wildcard pattern',
    '  "/score/i"            regex literal',
  ].join('\n');
}
