import type { PayloadStoreAdapter, StructureStoreAdapter } from '../types.js';

export type PayloadShipWorkItem = {
  kind: 'payload';
  ref: string;
  localPath: string;
  mtimeMs: number;
};

export type StructureTraceShipWorkItem = {
  kind: 'structure-trace';
  traceId: string;
  ref: string;
  localPath: string;
  mtimeMs: number;
};

export type StructureRunsShipWorkItem = {
  kind: 'structure-runs';
  traceId: string;
  ref: string;
  localPath: string;
  mtimeMs: number;
};

export type ShipWorkItem =
  | PayloadShipWorkItem
  | StructureTraceShipWorkItem
  | StructureRunsShipWorkItem;

/**
 * Structure files shipped so far, keyed by ref, with the mtime that was uploaded. Payloads need no
 * state: a payload is pending exactly while its local file exists, since it is deleted after upload.
 */
export type ShipperState = {
  structure: Record<string, number>;
};

export type TraceShipperDeps = {
  root: string;
  payloadDest: PayloadStoreAdapter;
  structureDest: StructureStoreAdapter;
};

export type ShipFailure = {
  ref: string;
  message: string;
};

export type ReplicateOnceResult = {
  uploadedPayloads: number;
  uploadedStructure: number;
  pendingPayloads: number;
  pendingStructure: number;
  oldestPendingMs: number | null;
  /** Items that failed this tick; they stay pending and are retried on the next tick. */
  failures: ShipFailure[];
};
