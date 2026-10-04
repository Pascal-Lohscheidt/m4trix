#!/usr/bin/env node
import type { TraceViewerApi } from '@m4trix/tracing';
import { version } from '../package.json';
import { CliParseError, cliHelpText, type ParsedCli, parseCliArgs } from './cli-args';
import { createAwsStackTraceViewerApi } from './aws-setup';
import { createFsTraceViewerApi } from './fs-setup';
import { startTraceMcpStdioServer } from './mcp/server';
import { startTraceViewerServer } from './server/start-server';

const program = 'm4trix-trace-viewer';

function createTraceViewerApi(cfg: ParsedCli): TraceViewerApi {
  if (cfg.adapter === 'aws-stack') {
    try {
      return createAwsStackTraceViewerApi();
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
  return createFsTraceViewerApi(tracePath);
}

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

  const traceViewerApi = createTraceViewerApi(cfg);

  if (cfg.command === 'mcp') {
    // stdout carries the MCP protocol; diagnostics must go to stderr.
    startTraceMcpStdioServer({ traceViewerApi, version }).catch((error: unknown) => {
      console.error(
        `${program}: MCP server failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
    return;
  }

  startTraceViewerServer({ traceViewerApi, port: cfg.port });
}

main();
