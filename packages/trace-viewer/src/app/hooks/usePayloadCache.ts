import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from '../api/client';

export function usePayloadCache(traceId: string | null) {
  const [payloadCache, setPayloadCache] = useState<Record<string, unknown>>({});
  const [payloadLoading, setPayloadLoading] = useState<string | null>(null);
  const [tracePayloadBatchLoading, setTracePayloadBatchLoading] = useState(false);
  const batchInFlightRef = useRef(false);

  // Clear cached payloads when switching traces (refs are not stable across traces).
  // biome-ignore lint/correctness/useExhaustiveDependencies: must run when `traceId` changes
  useEffect(() => {
    setPayloadCache({});
  }, [traceId]);

  const loadPayload = useCallback(async (ref: string) => {
    setPayloadLoading(ref);
    try {
      const data = await client.traces.getPayload.query({ ref });
      setPayloadCache((prev) => ({ ...prev, [ref]: data }));
    } finally {
      setPayloadLoading(null);
    }
  }, []);

  const loadManyPayloads = useCallback(async (refs: string[]) => {
    const unique = [...new Set(refs.filter(Boolean))];
    if (unique.length === 0) return;
    if (batchInFlightRef.current) return;
    batchInFlightRef.current = true;
    setTracePayloadBatchLoading(true);
    try {
      const entries = await Promise.all(
        unique.map(async (ref) => {
          const data = await client.traces.getPayload.query({ ref });
          return [ref, data] as const;
        }),
      );
      setPayloadCache((prev) => {
        const next = { ...prev };
        for (const [ref, data] of entries) {
          next[ref] = data;
        }
        return next;
      });
    } finally {
      setTracePayloadBatchLoading(false);
      batchInFlightRef.current = false;
    }
  }, []);

  return {
    payloadCache,
    payloadLoading,
    tracePayloadBatchLoading,
    loadPayload,
    loadManyPayloads,
  };
}
