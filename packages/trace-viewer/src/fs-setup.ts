import { resolve } from 'node:path';
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
  TraceViewerApi,
} from '@m4trix/tracing';

export function createFsTraceViewerApi(traceRootPath: string): TraceViewerApi {
  const path = resolve(traceRootPath);
  const traceStore = TraceStore.of({
    structureStoreAdapter: new FsStructureStoreAdapter({ path }),
    payloadStoreAdapter: new FsPayloadStoreAdapter({ path }),
  });
  return TraceViewerApi.from(traceStore);
}
