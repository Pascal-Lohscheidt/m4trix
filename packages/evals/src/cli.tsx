#!/usr/bin/env node
import { withFullScreen } from 'fullscreen-ink';

import { EvalsCliApp } from './cli/app';
import { loadMockData, loadRunnerData, parseStartupArgs } from './cli/state';
import { createRunner } from './runner';

async function main(): Promise<void> {
  const args = parseStartupArgs(process.argv.slice(2));
  const runner = createRunner();
  const data = await loadRunnerData(runner).catch(() => loadMockData());

  process.on('SIGINT', () => {
    void runner.shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void runner.shutdown().finally(() => process.exit(0));
  });

  withFullScreen(
    <EvalsCliApp data={data} args={args} runner={runner} />,
  ).start();
}

void main();
