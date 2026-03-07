#!/usr/bin/env node

import { createRunner } from '../runner';
import { getDefaultConcurrency, getSimpleCliUsage, parseSimpleCliArgs } from './args';
import { printBanner } from './banner';
import {
  generateDatasetJsonCommandInk,
  generateDatasetJsonCommandPlain,
} from './generate';
import {
  runSimpleEvalCommandInk,
  runSimpleEvalCommandPlain,
} from './run';

function printUsageAndExit(exitCode: number): never {
  const printer = exitCode === 0 ? console.log : console.error;
  printer(getSimpleCliUsage());
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = parseSimpleCliArgs(process.argv.slice(2));

  if (args.help) {
    printUsageAndExit(0);
  }
  if (args.unknownArgs.length > 0) {
    console.error(`Unknown arguments: ${args.unknownArgs.join(', ')}`);
    printUsageAndExit(1);
  }
  if (!args.command) {
    printUsageAndExit(1);
  }
  if (!args.datasetName) {
    console.error('Missing required --dataset <datasetName> argument.');
    printUsageAndExit(1);
  }

  if (args.command === 'run' && !args.evaluatorPattern) {
    console.error('Missing required --evaluator <name-or-pattern> argument.');
    printUsageAndExit(1);
  }

  const useInk = process.stdout.isTTY === true;
  if (!useInk) {
    printBanner();
  }

  const runner = createRunner();
  try {
    if (args.command === 'run') {
      const concurrency = args.concurrency ?? getDefaultConcurrency();
      await (useInk ? runSimpleEvalCommandInk : runSimpleEvalCommandPlain)(
        runner,
        args.datasetName,
        args.evaluatorPattern!,
        concurrency,
      );
      return;
    }

    await (useInk ? generateDatasetJsonCommandInk : generateDatasetJsonCommandPlain)(
      runner,
      args.datasetName,
    );
  } finally {
    await runner.shutdown();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exit(1);
});
