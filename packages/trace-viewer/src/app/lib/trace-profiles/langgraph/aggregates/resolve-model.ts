import type { RunNode } from '../../../../types';
import { asRecord } from './utils';

const METADATA_MODEL_KEYS = [
  'model',
  'model_name',
  'ls_model_name',
  'ls_model',
  'llm',
  'deployment',
] as const;

const PAYLOAD_MODEL_PATHS = [
  'model',
  'response_metadata',
  'kwargs',
  'lc_kwargs',
  'additional_kwargs',
  'message',
  'response',
] as const;

function readModelString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function extractModelFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  const o = asRecord(value);
  if (!o) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = extractModelFromUnknown(item, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const direct =
    readModelString(o.model) ??
    readModelString(o.model_name) ??
    readModelString(o.model_id) ??
    readModelString(o.deployment);
  if (direct) return direct;

  const responseMeta = asRecord(o.response_metadata);
  const fromMeta = responseMeta ? readModelString(responseMeta.model) : null;
  if (fromMeta) return fromMeta;

  for (const key of PAYLOAD_MODEL_PATHS) {
    if (key in o) {
      const found = extractModelFromUnknown(o[key], depth + 1);
      if (found) return found;
    }
  }
  if (Array.isArray(o.messages)) {
    for (const msg of o.messages) {
      const found = extractModelFromUnknown(msg, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Best-effort model id for pricing lookup on a single run. */
export function resolveModelNameForRun(
  node: RunNode,
  payloadCache: Record<string, unknown>,
): string | null {
  if (node.metadata) {
    const meta = node.metadata as Record<string, unknown>;
    for (const key of METADATA_MODEL_KEYS) {
      const found = readModelString(meta[key]);
      if (found) return found;
    }
  }

  for (const ref of [node.outputRef, node.inputRef]) {
    if (!ref || payloadCache[ref] === undefined) continue;
    const fromPayload = extractModelFromUnknown(payloadCache[ref]);
    if (fromPayload) return fromPayload;
  }

  return null;
}
