import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
  Tracer,
} from '@m4trix/tracing';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const traceOutputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../tmp/assistant-app-traces',
);

export const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: traceOutputPath }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: traceOutputPath }),
});

export const tracer = Tracer.from(traceStore);

export { traceOutputPath };
