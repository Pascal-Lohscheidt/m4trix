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

export type ShipperState = {
  payloads: Record<string, true>;
  structure: Record<string, number>;
};

export type TraceShipperDeps = {
  root: string;
  payloadDest: PayloadStoreAdapter;
  structureDest: StructureStoreAdapter;
};

export type ReplicateOnceResult = {
  uploadedPayloads: number;
  uploadedStructure: number;
  pendingPayloads: number;
  pendingStructure: number;
  oldestPendingMs: number | null;
};
