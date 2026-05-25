'use client';

import {
  DatabaseIcon,
  FolderOpenIcon,
  HardDrivesIcon,
  PencilSimpleLineIcon,
  PlugsConnectedIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import ConceptExplorer, { type ConceptItem } from './ConceptExplorer';

const TRACING_PRIMITIVES: ConceptItem[] = [
  {
    id: 'tracer',
    icon: PlugsConnectedIcon,
    label: 'Tracer',
    headline: 'Drop-in LangGraph and LangChain callbacks',
    body: (
      <>
        <code className="inline-code text-[11px]">Tracer.from(traceStore)</code> implements the
        callback surface LangGraph expects. Pass{' '}
        <code className="inline-code text-[11px]">tracer.adapt(toLangGraph)</code> to{' '}
        <code className="inline-code text-[11px]">callbacks</code> — every chain, LLM, tool, and
        retriever span lands in your store without rewriting agent code.
      </>
    ),
    bullets: [
      'Handles chain, LLM, chat model, tool, and retriever events',
      'Batches pending runs on flush for efficient writes',
      'Typed LangGraph adapter via toLangGraph',
    ],
    code: {
      filename: 'agent.ts',
      language: 'typescript',
      source: `import { Tracer, toLangGraph } from '@m4trix/tracing';

const tracer = Tracer.from(traceStore);
const lgTracer = tracer.adapt(toLangGraph);

await graph.invoke(input, { callbacks: [lgTracer] });
await lgTracer.flush();`,
    },
  },
  {
    id: 'trace-store',
    icon: DatabaseIcon,
    label: 'TraceStore',
    headline: 'Compose structure and payload adapters',
    body: (
      <>
        A TraceStore splits metadata from blobs. Structure adapters handle trace summaries and run
        rows; payload adapters store prompts, completions, and tool I/O by reference. Swap FS for S3
        and Dynamo without touching your tracer or viewer.
      </>
    ),
    bullets: [
      'Single API for upsert, list, get, and annotation patches',
      'Structure and payload concerns stay independently pluggable',
      'Same interface for local files and cloud backends',
    ],
    code: {
      filename: 'trace-store.ts',
      language: 'typescript',
      source: `import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
} from '@m4trix/tracing';

const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: './.traces' }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: './.traces' }),
});`,
    },
  },
  {
    id: 'structure-store',
    icon: HardDrivesIcon,
    label: 'Structure Store',
    headline: 'Small, queryable rows for trace metadata',
    body: (
      <>
        Structure adapters persist trace summaries and run records — IDs, timing, status, token
        counts, and payload refs. List and filter traces without loading full prompt/completion
        bodies into memory.
      </>
    ),
    bullets: [
      'Filesystem adapter writes trace.json and runs.ndjson per trace',
      'DynamoDB adapter for serverless and multi-tenant deployments',
      'Supports batch upsert for high-throughput callback flushes',
    ],
    code: {
      filename: 'structure-adapter.ts',
      language: 'typescript',
      source: `import { FsStructureStoreAdapter } from '@m4trix/tracing';

const structureStore = new FsStructureStoreAdapter({
  path: './.traces',
});

// Layout on disk:
// .traces/traces/{traceId}/trace.json
// .traces/traces/{traceId}/runs.ndjson`,
    },
  },
  {
    id: 'payload-store',
    icon: FolderOpenIcon,
    label: 'Payload Store',
    headline: 'Blob refs for prompts, outputs, and events',
    body: (
      <>
        Payload adapters store the heavy JSON — model inputs, completions, tool arguments, and event
        streams. Runs keep lightweight <code className="inline-code text-[11px]">inputRef</code> /{' '}
        <code className="inline-code text-[11px]">outputRef</code> pointers so you fetch payloads
        only when reviewing a specific span.
      </>
    ),
    bullets: [
      'Filesystem and S3 adapters ship with the package',
      'Optional stream support for large or chunked payloads',
      'Refs are path-safe — no parent-directory escapes',
    ],
    code: {
      filename: 'payload-adapter.ts',
      language: 'typescript',
      source: `import { FsPayloadStoreAdapter } from '@m4trix/tracing';

const payloadStore = new FsPayloadStoreAdapter({ path: './.traces' });

const inputRef = await payloadStore.putJson(
  'traces/abc/runs/llm-1/input.json',
  { messages: [{ role: 'user', content: 'Hello' }] },
);`,
    },
  },
  {
    id: 'trace-viewer-api',
    icon: TreeStructureIcon,
    label: 'TraceViewerApi',
    headline: 'Read back what you wrote — same store, no replica',
    body: (
      <>
        TraceViewerApi wraps TraceStore for UI and HTTP layers. List traces with cursors,
        reconstruct full span trees with nested children, and resolve payload refs on demand — the
        same adapter pair that captured the run serves it back.
      </>
    ),
    bullets: [
      'getTraceTree returns a nested TraceRunNode from flat run rows',
      'listTraces supports projectId filters and pagination',
      'Powers @m4trix/trace-viewer and your own review tools',
    ],
    code: {
      filename: 'viewer.ts',
      language: 'typescript',
      source: `import { TraceViewerApi } from '@m4trix/tracing';

const api = TraceViewerApi.from(traceStore);

const { traces } = await api.listTraces({ limit: 25 });
const tree = await api.getTraceTree(traces[0].traceId);
const input = await api.getPayload(tree.root.inputRef!);`,
    },
  },
  {
    id: 'annotations',
    icon: PencilSimpleLineIcon,
    label: 'Annotations',
    headline: 'Human review labels on traces and runs',
    body: (
      <>
        Annotations are post-hoc JSON on traces and runs — separate from execution metadata. Patch
        review status, notes, or workflow labels after a run completes. Deep-merge by default; set{' '}
        <code className="inline-code text-[11px]">merge: false</code> to replace the whole object.
      </>
    ),
    bullets: [
      'patchTraceAnnotation for run-level review state',
      'patchRunAnnotation for per-span notes and labels',
      'Stored alongside structure rows — no third-party review tool required',
    ],
    code: {
      filename: 'review.ts',
      language: 'typescript',
      source: `await traceViewerApi.patchTraceAnnotation({
  traceId,
  annotation: { review: { status: 'approved', author: 'pascal' } },
});

await traceViewerApi.patchRunAnnotation({
  traceId,
  runId,
  annotation: { note: 'tool returned empty payload' },
});`,
    },
  },
];

export default function TracingPrimitivesExplorer() {
  return (
    <ConceptExplorer
      items={TRACING_PRIMITIVES}
      ariaLabel="Tracing primitives"
      idPrefix="tracing-primitive"
    />
  );
}
