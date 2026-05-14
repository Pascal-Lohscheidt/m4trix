import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { RunNode, TraceRow, TraceTree } from '../types';

export function useSelectedTraceTree(traceId: string | null) {
  const [tree, setTree] = useState<TraceTree | null>(null);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!traceId) {
      setTree(null);
      setRunId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await client.traces.getTree.query({ traceId });
        if (cancelled) return;
        if (!r) {
          setTree(null);
          setTreeErr('Trace not found');
          return;
        }
        setTree({ trace: r.trace as TraceRow, root: r.root as RunNode });
        setTreeErr(null);
        setRunId(r.root.runId);
      } catch (e) {
        if (cancelled) return;
        setTreeErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  return { tree, treeErr, runId, setRunId };
}
