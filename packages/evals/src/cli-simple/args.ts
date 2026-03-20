export type SimpleCliCommand = 'run' | 'generate';

export interface SimpleCliArgs {
  command?: SimpleCliCommand;
  /** For `generate` only. */
  datasetName?: string;
  /** Repeatable: each `--run-config` adds a RunConfig to execute (expanded jobs run with shared concurrency). */
  runConfigNames: string[];
  /** Max concurrent evaluations. Default: 4. Use 1 for sequential. */
  concurrency?: number;
  /** Optional label passed to evaluator `meta.experimentName` for this CLI run. */
  experimentName?: string;
  /**
   * When set (typically for `run`), exit with code 1 if any test case fails.
   * Ignored for `generate`.
   */
  ci: boolean;
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
    ci: false,
    runConfigNames: [],
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
    if (token === '--ci') {
      args.ci = true;
      continue;
    }
    if ((token === '--dataset' || token === '--datasetName') && argv[index + 1]) {
      args.datasetName = argv[index + 1];
      index += 1;
      continue;
    }
    if ((token === '--run-config' || token === '--runConfig') && argv[index + 1]) {
      const next = argv[index + 1];
      if (typeof next === 'string') {
        args.runConfigNames.push(next);
      }
      index += 1;
      continue;
    }
    if ((token === '--concurrency' || token === '-c') && argv[index + 1]) {
      const nextConc = argv[index + 1];
      const n = typeof nextConc === 'string' ? parseInt(nextConc, 10) : Number.NaN;
      if (!Number.isNaN(n) && n >= 1) {
        args.concurrency = n;
      }
      index += 1;
      continue;
    }
    if (token === '--experiment' && argv[index + 1]) {
      const raw = argv[index + 1];
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          args.experimentName = trimmed;
        }
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
    '  eval-agents-simple run --run-config <name> [--run-config <name> ...] [--concurrency N] [--experiment <name>] [--ci]',
    '  eval-agents-simple generate --dataset <datasetId>',
    '',
    'Options:',
    '  --ci                  With run: exit with code 1 if any test case fails.',
    '  --concurrency, -c N   Max concurrent evaluations (default: 4). Use 1 for sequential.',
    '  --experiment <name>   With run: set evaluator meta.experimentName for this invocation.',
  ].join('\n');
}
