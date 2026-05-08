import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { AppRouter } from '../server/router';

const client = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${window.location.origin}/trpc`,
    }),
  ],
});

type TraceRow = {
  traceId: string;
  name: string;
  status: string;
  startTime: string;
  runCount: number;
  projectId?: string;
};

type RunNode = {
  runId: string;
  parentRunId?: string;
  name: string;
  type: string;
  status: string;
  startTime: string;
  endTime?: string;
  latencyMs?: number;
  error?: { message: string; type?: string };
  inputRef?: string;
  outputRef?: string;
  metadata?: Record<string, string | number | boolean>;
  children: RunNode[];
};

function statusColor(status: string): string {
  switch (status) {
    case 'success':
      return '#34d399';
    case 'error':
      return '#f87171';
    default:
      return '#fbbf24';
  }
}

function RunTree(props: {
  node: RunNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  const { node, depth, selectedId, onSelect } = props;
  const pad = 10 + depth * 14;
  const sel = node.runId === selectedId;
  return (
    <div key={node.runId}>
      <button
        type="button"
        onClick={() => onSelect(node.runId)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '6px 10px 6px 10px',
          marginLeft: pad,
          marginBottom: 2,
          borderRadius: 6,
          border: sel ? '1px solid #fbbf24' : '1px solid #3f3f46',
          background: sel ? '#27272a' : '#18181b',
          color: '#e4e4e7',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        <span style={{ color: '#a1a1aa', marginRight: 8 }}>{node.type}</span>
        {node.name}
        <span style={{ color: statusColor(node.status), marginLeft: 8, fontSize: 12 }}>
          {node.status}
        </span>
      </button>
      {node.children.map((c) => (
        <RunTree
          key={c.runId}
          node={c}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function App(): ReactNode {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [tree, setTree] = useState<{ trace: TraceRow; root: RunNode } | null>(null);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [payloadCache, setPayloadCache] = useState<Record<string, unknown>>({});
  const [payloadLoading, setPayloadLoading] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await client.traces.list.query({});
        if (cancelled) return;
        setTraces(r.traces as TraceRow[]);
        setListErr(null);
      } catch (e) {
        if (cancelled) return;
        setListErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const selectedRun = useMemo(() => {
    if (!tree || !runId) return null;
    const walk = (n: RunNode): RunNode | null => {
      if (n.runId === runId) return n;
      for (const c of n.children) {
        const f = walk(c);
        if (f) return f;
      }
      return null;
    };
    return walk(tree.root);
  }, [tree, runId]);

  const loadPayload = useCallback(async (ref: string) => {
    setPayloadLoading(ref);
    try {
      const data = await client.traces.getPayload.query({ ref });
      setPayloadCache((prev) => ({ ...prev, [ref]: data }));
    } finally {
      setPayloadLoading(null);
    }
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 280,
          flexShrink: 0,
          borderRight: '1px solid #27272a',
          background: '#09090b',
          padding: 12,
          overflowY: 'auto',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 12, color: '#fafafa' }}>Traces</div>
        {listErr && <div style={{ color: '#f87171', fontSize: 13 }}>{listErr}</div>}
        {traces.map((t) => (
          <button
            key={t.traceId}
            type="button"
            onClick={() => setTraceId(t.traceId)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              marginBottom: 8,
              borderRadius: 8,
              border: traceId === t.traceId ? '1px solid #fbbf24' : '1px solid #3f3f46',
              background: traceId === t.traceId ? '#27272a' : '#18181b',
              color: '#e4e4e7',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500 }}>{t.name || t.traceId}</div>
            <div style={{ fontSize: 12, color: '#a1a1aa', marginTop: 4 }}>
              <span style={{ color: statusColor(t.status) }}>{t.status}</span>
              {' · '}
              {t.runCount} runs
            </div>
            <div style={{ fontSize: 11, color: '#71717a', marginTop: 2 }}>{t.startTime}</div>
          </button>
        ))}
      </aside>
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          background: '#18181b',
        }}
      >
        {!tree && (
          <div style={{ padding: 24, color: '#a1a1aa' }}>
            {treeErr ?? 'Select a trace to inspect runs and payloads.'}
          </div>
        )}
        {tree && (
          <>
            <header
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid #27272a',
                background: '#09090b',
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 600, color: '#fafafa' }}>
                {tree.trace.name}
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: '#a1a1aa' }}>
                <span style={{ color: statusColor(tree.trace.status) }}>{tree.trace.status}</span>
                {' · '}
                {tree.trace.runCount} runs
                {tree.trace.projectId ? ` · project ${tree.trace.projectId}` : ''}
                {' · '}
                {tree.trace.startTime}
              </div>
            </header>
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              <section
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: 16,
                  overflowY: 'auto',
                  borderRight: '1px solid #27272a',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 12, color: '#e4e4e7' }}>Run tree</div>
                {treeErr && <div style={{ color: '#f87171' }}>{treeErr}</div>}
                <RunTree node={tree.root} depth={0} selectedId={runId} onSelect={setRunId} />
              </section>
              <section style={{ width: 420, flexShrink: 0, padding: 16, overflowY: 'auto' }}>
                <div style={{ fontWeight: 600, marginBottom: 12, color: '#e4e4e7' }}>
                  Run detail
                </div>
                {!selectedRun && <div style={{ color: '#71717a' }}>Select a run.</div>}
                {selectedRun && (
                  <div style={{ fontSize: 13, color: '#d4d4d8' }}>
                    <div>
                      <strong style={{ color: '#fafafa' }}>{selectedRun.name}</strong>{' '}
                      <span style={{ color: '#a1a1aa' }}>({selectedRun.type})</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      status:{' '}
                      <span style={{ color: statusColor(selectedRun.status) }}>
                        {selectedRun.status}
                      </span>
                    </div>
                    <div style={{ marginTop: 4 }}>start: {selectedRun.startTime}</div>
                    {selectedRun.endTime && (
                      <div style={{ marginTop: 4 }}>end: {selectedRun.endTime}</div>
                    )}
                    {selectedRun.latencyMs != null && (
                      <div style={{ marginTop: 4 }}>latency: {selectedRun.latencyMs} ms</div>
                    )}
                    {selectedRun.error && (
                      <div style={{ marginTop: 12, color: '#f87171' }}>
                        Error: {selectedRun.error.message}
                      </div>
                    )}
                    {selectedRun.metadata && Object.keys(selectedRun.metadata).length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>Metadata</div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 10,
                            background: '#09090b',
                            borderRadius: 8,
                            border: '1px solid #27272a',
                            overflow: 'auto',
                            fontSize: 12,
                          }}
                        >
                          {JSON.stringify(selectedRun.metadata, null, 2)}
                        </pre>
                      </div>
                    )}
                    <PayloadSection
                      label="Input"
                      refId={selectedRun.inputRef}
                      payloadCache={payloadCache}
                      loadingRef={payloadLoading}
                      onLoad={loadPayload}
                    />
                    <PayloadSection
                      label="Output"
                      refId={selectedRun.outputRef}
                      payloadCache={payloadCache}
                      loadingRef={payloadLoading}
                      onLoad={loadPayload}
                    />
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function PayloadSection(props: {
  label: string;
  refId?: string;
  payloadCache: Record<string, unknown>;
  loadingRef: string | null;
  onLoad: (ref: string) => void;
}): ReactNode {
  const { label, refId, payloadCache, loadingRef, onLoad } = props;
  if (!refId) {
    return (
      <div style={{ marginTop: 16, color: '#71717a' }}>
        {label}: <em>no ref</em>
      </div>
    );
  }
  const loaded = payloadCache[refId] !== undefined;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <code style={{ fontSize: 11, color: '#a1a1aa' }}>{refId}</code>
        {!loaded && (
          <button
            type="button"
            onClick={() => onLoad(refId)}
            disabled={loadingRef === refId}
            style={{
              marginLeft: 'auto',
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid #3f3f46',
              background: '#27272a',
              color: '#fafafa',
              cursor: loadingRef === refId ? 'wait' : 'pointer',
            }}
          >
            {loadingRef === refId ? 'Loading…' : 'Load JSON'}
          </button>
        )}
      </div>
      {loaded && (
        <pre
          style={{
            margin: 0,
            padding: 10,
            background: '#09090b',
            borderRadius: 8,
            border: '1px solid #27272a',
            overflow: 'auto',
            maxHeight: 320,
            fontSize: 12,
          }}
        >
          {JSON.stringify(payloadCache[refId], null, 2)}
        </pre>
      )}
    </div>
  );
}
