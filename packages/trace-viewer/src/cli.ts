#!/usr/bin/env node
import { CliParseError, cliHelpText, type ParsedCli, parseCliArgs } from './cli-args';
import { createFsTraceViewerApi } from './fs-setup';
import { startTraceViewerServer } from './server/start-server';

const program = 'm4trix-trace-viewer';

function main(): void {
  let cfg: ParsedCli;
  try {
    cfg = parseCliArgs(process.argv);
  } catch (e) {
    if (e instanceof CliParseError && e.message === 'HELP') {
      console.log(cliHelpText(program));
      process.exit(0);
    }
    if (e instanceof CliParseError) {
      console.error(`${program}: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  if (cfg.adapter === 'aws-stack') {
    console.error(
      `${program}: --adapter aws-stack is not implemented yet. Use --adapter fs with a trace directory.`,
    );
    process.exit(1);
  }

  const tracePath = cfg.path;
  if (!tracePath) {
    console.error(`${program}: --path is required for the fs adapter`);
    process.exit(2);
  }

  const traceViewerApi = createFsTraceViewerApi(tracePath);
  startTraceViewerServer({ traceViewerApi, port: cfg.port });
}

main();
