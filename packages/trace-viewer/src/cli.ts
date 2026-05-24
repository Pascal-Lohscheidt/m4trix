#!/usr/bin/env node
import { CliParseError, cliHelpText, type ParsedCli, parseCliArgs } from './cli-args';
import { createAwsStackTraceViewerApi } from './aws-setup';
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
    try {
      const traceViewerApi = createAwsStackTraceViewerApi();
      startTraceViewerServer({ traceViewerApi, port: cfg.port });
      return;
    } catch (error) {
      console.error(
        `${program}: failed to start aws-stack adapter — ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(
        `${program}: set TRACE_DYNAMO_TABLE, TRACE_S3_BUCKET, and AWS_REGION (optional: TRACE_S3_PREFIX, AWS_ENDPOINT_URL).`,
      );
      process.exit(1);
    }
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
