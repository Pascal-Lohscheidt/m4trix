import { parseArgs } from 'node:util';
import { DEFAULT_CONTEXT_BUDGET } from './context.js';

/**
 * The CLI's options in `argv` (`process.argv.slice(2)`), with defaults from `env`. A leading `--`
 * is dropped: `pnpm start -- -p …` passes it on (npm does not), and it is not an argument of the
 * CLI. Throws for an unknown option or a positional argument.
 */
export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : [...argv],
    options: {
      print: { type: 'string', short: 'p' },
      cwd: { type: 'string', default: process.cwd() },
      model: { type: 'string', default: env.M4TRIX_CODE_MODEL ?? 'gpt-5.4' },
      yes: { type: 'boolean', short: 'y', default: false },
      'max-steps': { type: 'string', default: '60' },
      'context-budget': { type: 'string', default: String(DEFAULT_CONTEXT_BUDGET) },
      session: { type: 'string' },
      trace: { type: 'boolean', default: false },
    },
  });
  return values;
}
