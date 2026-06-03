import 'dotenv/config';
import { configureProcessLogging } from './logging.js';
import { createAssistantContext } from './server/context.js';
import { startAssistantServer } from './server/start-server.js';

const DEFAULT_PORT = 4320;

function parseServerArgv(argv: string[]): { port: number; withLogs: boolean } {
  let port = DEFAULT_PORT;
  let withLogs = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--with-logs') {
      withLogs = true;
      continue;
    }
    if (arg === '--port') {
      const value = argv[i + 1];
      if (!value) throw new Error('--port requires a value');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid --port "${value}"`);
      }
      port = parsed;
      i++;
    }
  }

  return { port, withLogs };
}

async function main(): Promise<void> {
  const { port, withLogs } = parseServerArgv(process.argv);
  if (withLogs) {
    process.env.ASSISTANT_WITH_LOGS = '1';
  }
  configureProcessLogging();

  const context = await createAssistantContext();
  startAssistantServer({ context, port });
}

main().catch((error) => {
  process.stderr.write(
    `assistant-server: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
