#!/usr/bin/env node

import { createRunner } from '../runner';
import { getDefaultConcurrency, getSimpleCliUsage, parseSimpleCliArgs } from './args';
import { printBanner } from './banner';
import { generateDatasetJsonCommandInk, generateDatasetJsonCommandPlain } from './generate';
import { runSimpleEvalRunConfigsInk, runSimpleEvalRunConfigsPlain } from './run';

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

  if (args.command === 'run') {
    if (args.runConfigNames.length === 0) {
      console.error(
        'Missing required --run-config <name> (repeat the flag to queue multiple RunConfigs).',
      );
      printUsageAndExit(1);
    }
    if (args.datasetName !== undefined) {
      console.error(
        'The run command no longer accepts --dataset; use --run-config <RunConfig name>.',
      );
      printUsageAndExit(1);
    }
  }

  if (args.command === 'generate' && args.runConfigNames.length > 0) {
    console.error('generate does not accept --run-config.');
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
      const exitCode = await (useInk ? runSimpleEvalRunConfigsInk : runSimpleEvalRunConfigsPlain)(
        runner,
        args.runConfigNames,
        concurrency,
      );
      if (args.ci && exitCode !== 0) {
        process.exit(1);
      }
      return;
    }

    const genDataset = args.datasetName;
    if (!genDataset) {
      console.error('Missing required --dataset <datasetId> argument.');
      printUsageAndExit(1);
    }
    await (useInk ? generateDatasetJsonCommandInk : generateDatasetJsonCommandPlain)(
      runner,
      genDataset,
    );
  } finally {
    await runner.shutdown();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exit(1);
});
