---
title: "Quick Start"
---

Install the packages:

```bash
pnpm add @m4trix/tracing @m4trix/trace-viewer
```

Create a filesystem-backed trace store:

```ts
// src/tracing.ts
import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
  Tracer,
} from '@m4trix/tracing';

export function createTracer(path = './tmp/traces'): Tracer {
  const traceStore = TraceStore.of({
    structureStoreAdapter: new FsStructureStoreAdapter({ path }),
    payloadStoreAdapter: new FsPayloadStoreAdapter({ path }),
  });

  return Tracer.from(traceStore);
}
```

## Attach the Tracer

Pass the tracer through LangGraph or LangChain callback options:

```ts
import { createTracer } from './tracing';

const tracer = createTracer('./tmp/traces');

await graph.invoke(
  { messages: [{ role: 'user', content: 'Summarize this ticket.' }] },
  {
    callbacks: [tracer],
    metadata: {
      projectId: 'support-agent',
      env: 'dev',
    },
  },
);

await tracer.flush();
```

`flush()` waits for in-flight callback writes, batches pending runs, and writes the final trace snapshots. Call it before your script exits or before you expect the trace viewer to show the latest run.

## Run the Viewer

Start the local viewer against the same trace root:

```bash
pnpm exec m4trix-trace-viewer --adapter fs --path ./tmp/traces --port 4319
```

Open `http://127.0.0.1:4319`.

The viewer lists traces, shows the run tree, and lazy-loads input/output payloads when you select a run.

## Try the Repository Example

From the repository root:

```bash
pnpm --filter @examples/tracing-example example
pnpm exec m4trix-trace-viewer --adapter fs --path ./tmp/tracing-example --port 4319
```

The example builds a mock LangGraph workflow with planner, researcher, lookup, summarizer, and reviewer nodes so the viewer has a nested trace tree to inspect.

