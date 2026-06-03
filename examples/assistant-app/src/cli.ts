#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantClient } from './client/trpc.js';
import { runChatRepl } from './cli-chat.js';
import { CliParseError, cliHelpText, parseCliArgs } from './cli-args.js';
import { configureProcessLogging, withQuietNodeEnv } from './logging.js';

const program = 'm4trix-assistant';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveServerCommand(
  port: number,
  withLogs: boolean,
): { command: string; args: string[]; cwd: string } {
  const isDev = process.env.ASSISTANT_DEV === '1';
  const builtServer = join(packageRoot, 'dist/server-entry.js');

  const logArgs = withLogs ? ['--with-logs'] : [];

  if (isDev || !existsSync(builtServer)) {
    return {
      command: process.platform === 'win32' ? 'npx' : 'tsx',
      args:
        process.platform === 'win32'
          ? [
              'tsx',
              join(packageRoot, 'src/server-entry.ts'),
              '--port',
              String(port),
              ...logArgs,
            ]
          : [join(packageRoot, 'src/server-entry.ts'), '--port', String(port), ...logArgs],
      cwd: packageRoot,
    };
  }

  return {
    command: process.execPath,
    args: [builtServer, '--port', String(port), ...logArgs],
    cwd: packageRoot,
  };
}

async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
  const client = createAssistantClient(port);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await client.health.ping.query();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(`Server did not become ready on port ${port} within ${timeoutMs}ms`);
}

function spawnServer(port: number, withLogs: boolean): ChildProcess {
  const { command, args, cwd } = resolveServerCommand(port, withLogs);
  const child = spawn(command, args, {
    cwd,
    env: withQuietNodeEnv({
      ...process.env,
      ...(withLogs ? { ASSISTANT_WITH_LOGS: '1' } : {}),
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  child.on('error', (error) => {
    process.stderr.write(`${program}: failed to spawn server — ${error.message}\n`);
    process.exit(1);
  });

  return child;
}

async function main(): Promise<void> {
  let cfg: ReturnType<typeof parseCliArgs>;
  try {
    cfg = parseCliArgs(process.argv);
    if (cfg.withLogs) {
      process.env.ASSISTANT_WITH_LOGS = '1';
    }
    configureProcessLogging();
  } catch (error) {
    if (error instanceof CliParseError && error.message === 'HELP') {
      console.log(cliHelpText(program));
      process.exit(0);
    }
    if (error instanceof CliParseError) {
      process.stderr.write(`${program}: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const server = spawnServer(cfg.port, cfg.withLogs);

  const shutdown = (): void => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);

  try {
    await waitForServer(cfg.port);
    const client = createAssistantClient(cfg.port);
    await runChatRepl(client);
  } finally {
    shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`${program}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
