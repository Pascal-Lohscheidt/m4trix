#!/usr/bin/env node
import {
  DynamoStructureStoreAdapter,
  resolveDynamoStructureStoreOptionsFromEnv,
} from './storage-adapter/dynamo-structure-store-adapter.js';
import {
  resolveS3PayloadStoreOptionsFromEnv,
  S3PayloadStoreAdapter,
} from './storage-adapter/s3-payload-store-adapter.js';
import { parseIntervalMs, runShipperLoop } from './trace-shipper/run-loop.js';
import {
  type ParsedTraceShipperCli,
  parseTraceShipperCliArgs,
  TraceShipperCliParseError,
  traceShipperCliHelpText,
} from './trace-shipper-args.js';

const program = 'm4trix-tracing-sidecar';

function main(): void {
  let cfg: ParsedTraceShipperCli;
  try {
    cfg = parseTraceShipperCliArgs(process.argv);
  } catch (error) {
    if (error instanceof TraceShipperCliParseError && error.message === 'HELP') {
      console.log(traceShipperCliHelpText(program));
      process.exit(0);
    }
    if (error instanceof TraceShipperCliParseError) {
      console.error(`${program}: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  let intervalMs: number;
  try {
    intervalMs = parseIntervalMs(cfg.interval);
  } catch (error) {
    console.error(`${program}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let payloadDest: S3PayloadStoreAdapter;
  let structureDest: DynamoStructureStoreAdapter;
  try {
    payloadDest = new S3PayloadStoreAdapter(resolveS3PayloadStoreOptionsFromEnv());
    structureDest = new DynamoStructureStoreAdapter(resolveDynamoStructureStoreOptionsFromEnv());
  } catch (error) {
    console.error(
      `${program}: failed to configure AWS adapters — ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      `${program}: set TRACE_DYNAMO_TABLE, TRACE_S3_BUCKET, and AWS_REGION (optional: TRACE_S3_PREFIX, AWS_ENDPOINT_URL).`,
    );
    process.exit(1);
  }

  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => controller.abort());
  }

  runShipperLoop(
    {
      root: cfg.root,
      payloadDest,
      structureDest,
    },
    {
      intervalMs,
      once: cfg.once,
      signal: controller.signal,
      onTick(result) {
        const lag =
          result.oldestPendingMs === null
            ? 'none'
            : `${Math.max(0, Date.now() - result.oldestPendingMs)}ms`;
        console.log(
          `[trace-shipper] uploaded payloads=${result.uploadedPayloads} structure=${result.uploadedStructure} pending payloads=${result.pendingPayloads} structure=${result.pendingStructure} oldest=${lag}`,
        );
      },
    },
  ).catch((error) => {
    if (error instanceof Error && error.message === 'Aborted') {
      process.exit(0);
    }
    console.error(`${program}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

main();
