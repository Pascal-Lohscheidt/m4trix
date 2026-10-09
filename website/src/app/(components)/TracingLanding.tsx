'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import Image from 'next/image';
import {
  siClaude,
  siCursor,
  siDocker,
  siKubernetes,
  siLangchain,
  siLanggraph,
  siModelcontextprotocol,
} from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import type { PackageId } from '@/lib/packages';
import CodeBlock from './CodeBlock';
import CopyCommand from './CopyCommand';
import ClaudeConsoleGraphic from './graphics/ClaudeConsoleGraphic';
import RecordGraphic from './graphics/RecordGraphic';
import ShipGraphic from './graphics/ShipGraphic';
import SplitStorageGraphic from './graphics/SplitStorageGraphic';
import {
  ClosingCta,
  Faq,
  type FaqItem,
  Section,
  type Sibling,
  Toolkit,
  WorksWith,
} from './LandingSections';
import TracingPrimitivesExplorer from './TracingPrimitivesExplorer';

const DOCS_HREF = 'https://docs.m4trix.dev/tracing';

/* ─── Hero ─────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative z-[2] overflow-hidden px-4 pt-14 sm:px-6 sm:pt-20 lg:px-8">
      <div
        className="pointer-events-none absolute top-[-180px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full blur-[120px]"
        style={{ background: 'var(--glow-1)' }}
        aria-hidden
      />
      <div className="relative mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="eyebrow rise-in">Open-source agent tracing</p>
          <h1
            className="rise-in font-display text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.04] font-bold tracking-[-0.035em] text-text-1"
            style={{ '--rise-delay': '60ms' } as React.CSSProperties}
          >
            Agent tracing, <span className="text-(--accent) sm:block">without the platform.</span>
          </h1>
          <p
            className="rise-in mt-6 max-w-[54ch] text-[17px] leading-relaxed text-text-2 sm:text-lg"
            style={{ '--rise-delay': '120ms' } as React.CSSProperties}
          >
            A TypeScript library for LangGraph and LangChain. Traces land in your files or AWS
            account, and a local viewer opens them.
          </p>
          <div
            className="rise-in mt-8 flex flex-col gap-3 sm:flex-row sm:items-center"
            style={{ '--rise-delay': '180ms' } as React.CSSProperties}
          >
            <a href={DOCS_HREF} className="btn-primary group justify-center">
              Get started
              <ArrowRightIcon
                aria-hidden
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                weight="bold"
              />
            </a>
            <CopyCommand command="pnpm add @m4trix/tracing" />
          </div>
        </div>

        <div
          className="rise-in relative mt-14 sm:mt-16"
          style={{ '--rise-delay': '260ms' } as React.CSSProperties}
        >
          <div className="shot-frame">
            <Image
              src="/screens/trace-viewer-run.webp"
              alt="The m4trix trace viewer showing a LangGraph run tree with a selected tool call, its metadata, input and output payloads."
              width={2880}
              height={1800}
              priority
              sizes="(min-width: 1152px) 1152px, 100vw"
              className="block h-auto w-full"
            />
          </div>
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--bg))' }}
            aria-hidden
          />
        </div>
      </div>
    </section>
  );
}

/* ─── Works with ──────────────────────────────────────────────────────── */

const STACK = [
  siLanggraph,
  siLangchain,
  siModelcontextprotocol,
  siClaude,
  siCursor,
  siDocker,
  siKubernetes,
];

/* ─── MCP ─────────────────────────────────────────────────────────────── */

const MCP_TOOLS = [
  'list_traces',
  'find_runs',
  'search_payloads',
  'get_trace',
  'get_run',
  'get_payload',
  'get_conversation',
  'analyze_trace',
  'compare',
  'annotate',
  'load_trace_payloads',
];

function McpSection() {
  return (
    <Section>
      <div className="grid items-center gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-text-3">
            <BrandIcon icon={siModelcontextprotocol} className="h-6 w-6" />
            <BrandIcon icon={siClaude} className="h-6 w-6" />
            <BrandIcon icon={siCursor} className="h-6 w-6" />
          </div>
          <h2 className="lp-h2 mt-6">Let Claude Code debug the run</h2>
          <p className="lp-lead">
            The viewer serves an MCP endpoint on localhost. Claude Code reads the run tree, searches
            payloads and points at the call that broke.
          </p>
          <CodeBlock
            className="agent-code-block mt-8"
            code={'claude mcp add --transport http \\\n  m4trix-traces http://127.0.0.1:4319/mcp'}
            language="bash"
            filename="terminal"
          />
          <ul className="mt-6 flex flex-wrap gap-2" aria-label="MCP tools">
            {MCP_TOOLS.map((tool) => (
              <li key={tool} className="tool-chip">
                {tool}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <ClaudeConsoleGraphic />
        </div>
      </div>
    </Section>
  );
}

/* ─── Quickstart ──────────────────────────────────────────────────────── */

const QUICKSTART_CODE = `import {
  FsPayloadStoreAdapter,
  FsStructureStoreAdapter,
  TraceStore,
  Tracer,
  toLangGraph,
} from '@m4trix/tracing';

const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: './.traces' }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: './.traces' }),
});

const tracer = Tracer.from(traceStore).adapt(toLangGraph);

await graph.invoke(input, { callbacks: [tracer] });
await tracer.flush();`;

function Quickstart() {
  return (
    <Section id="quickstart">
      <h2 className="lp-h2">One callback. Every step recorded.</h2>
      <p className="lp-lead">
        The tracer speaks the LangChain callback API. Pass it to invoke and every chain, model and
        tool call lands in ./.traces.
      </p>
      <div className="mt-12">
        <RecordGraphic />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-[1.25fr_0.75fr] lg:items-start">
        <CodeBlock
          className="agent-code-block min-w-0"
          code={QUICKSTART_CODE}
          language="typescript"
          filename="agent.ts"
        />
        <div className="flex min-w-0 flex-col gap-4">
          <CodeBlock
            className="agent-code-block"
            code="pnpm add @m4trix/tracing"
            language="bash"
            filename="install"
          />
          <CodeBlock
            className="agent-code-block"
            code={'npx @m4trix/trace-viewer \\\n  --adapter fs --path ./.traces'}
            language="bash"
            filename="open the viewer"
          />
        </div>
      </div>
    </Section>
  );
}

/* ─── Bento ───────────────────────────────────────────────────────────── */

function Bento() {
  return (
    <Section>
      <h2 className="lp-h2 max-w-2xl">Open a run, see what happened</h2>
      <p className="lp-lead">
        Small rows for lists and filters, full payloads when you open a run, and notes that stay
        with the trace.
      </p>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        <div className="bento-cell bento-cell-accent lg:col-span-2">
          <h3 className="bento-title">Payloads that read like conversations</h3>
          <p className="bento-body max-w-[52ch]">
            Profiles turn raw JSON into messages, tool calls and tables. A model drafts the mapping
            from samples of your traces, with your own key, straight from the browser.
          </p>
          <div className="mt-6 overflow-hidden rounded-lg border border-(--border-md)">
            <Image
              src="/screens/trace-viewer-ai-profile.webp"
              alt="The New AI profile dialog in the trace viewer, sampling the current trace and sending it to the Claude API with a key held in browser memory."
              width={2060}
              height={1010}
              sizes="(min-width: 1024px) 720px, 100vw"
              className="block h-auto w-full"
            />
          </div>
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">Plain files on disk</h3>
          <p className="bento-body mb-6">
            No sign-up, no API key, no upload queue. Grep it, commit a fixture, or mount it in
            Docker.
          </p>
          <div className="mono-panel mt-auto pt-3">
            <span className="text-text-3">.traces/traces/</span>
            <br />
            <span className="text-(--accent)">└─ f19bca0d/</span>
            <br />
            &nbsp;&nbsp;&nbsp;├─ trace.json
            <br />
            &nbsp;&nbsp;&nbsp;├─ runs.ndjson
            <br />
            &nbsp;&nbsp;&nbsp;└─ payloads/
          </div>
        </div>

        <div className="bento-cell lg:col-span-2">
          <h3 className="bento-title">Split storage, one store</h3>
          <p className="bento-body mb-6 max-w-[60ch]">
            Structure rows stay small, so lists and filters are fast. Prompts and completions are
            blobs, fetched by ref when you open a run. The adapters that wrote them serve both back.
          </p>
          <SplitStorageGraphic />
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">Review in place</h3>
          <p className="bento-body">
            Annotate traces and single runs after the fact. Notes live next to the structure rows,
            not in another tool.
          </p>
          <code className="mono-panel mt-auto block text-(--cyan)">
            {"annotation: { review: 'approved' }"}
          </code>
        </div>
      </div>
    </Section>
  );
}

/* ─── Deploy path ─────────────────────────────────────────────────────── */

function DeployPath() {
  return (
    <Section>
      <h2 className="lp-h2 max-w-2xl">Start on a laptop. Ship to AWS when you need to.</h2>
      <p className="lp-lead">Same Tracer, same viewer at every stage. Only the adapters change.</p>
      <div className="mt-12">
        <ShipGraphic />
      </div>
    </Section>
  );
}

/* ─── API explorer ────────────────────────────────────────────────────── */

function ApiExplorer() {
  return (
    <Section>
      <h2 className="lp-h2">Six primitives. No platform.</h2>
      <p className="lp-lead mb-12">Swap any adapter without touching the tracer or the viewer.</p>
      <TracingPrimitivesExplorer />
    </Section>
  );
}

/* ─── FAQ ─────────────────────────────────────────────────────────────── */

const FAQ: FaqItem[] = [
  {
    q: 'Does anything leave my machine?',
    a: 'Not by default. The filesystem adapters write to a folder you choose. Data only moves if you configure the S3 and DynamoDB adapters or run the sidecar. AI profiles call the model provider directly from your browser, with your key.',
  },
  {
    q: 'Do I have to use LangGraph?',
    a: 'No. The Tracer implements the LangChain callback methods without importing LangChain, so anything that emits those callbacks works. LangGraph gets a typed adapter through toLangGraph.',
  },
  {
    q: 'How is this different from LangSmith or Langfuse?',
    a: 'Those are platforms: a hosted service, or a database and web app you operate. m4trix tracing is a library. Traces are files or rows in your own AWS account, and the viewer is a CLI you start when you need it.',
  },
  {
    q: 'Is it ready for production?',
    a: 'The sidecar pattern is built for it: the app writes locally and a companion container ships to S3 and DynamoDB. Sampling, PII redaction, viewer auth and retention policies are not included yet.',
  },
  {
    q: 'What does it cost?',
    a: 'Nothing. It is MIT licensed with no seats or usage tiers. You pay only for the storage you choose to use.',
  },
];

/* ─── Rest of the toolkit ─────────────────────────────────────────────── */

const SIBLINGS: Sibling[] = [
  {
    id: 'evals',
    name: '@m4trix/evals',
    title: 'Score every change',
    body: 'Datasets, evaluators and run configs as TypeScript files, run from the CLI like Vitest.',
  },
  {
    id: 'agents',
    name: '@m4trix/core',
    title: 'Orchestrate with events',
    body: 'Typed events, plain async handlers and channels that stream over SSE. Pre-alpha.',
  },
];

export default function TracingLanding({
  onSelectPackage,
}: {
  onSelectPackage: (pkg: PackageId) => void;
}) {
  return (
    <>
      <Hero />
      <WorksWith label="Fits the stack you already run" icons={STACK} />
      <McpSection />
      <Quickstart />
      <Bento />
      <DeployPath />
      <ApiExplorer />
      <Faq items={FAQ} />
      <Toolkit siblings={SIBLINGS} onSelectPackage={onSelectPackage} />
      <ClosingCta
        title="Trace your next run"
        body="One callback, one folder, one command to open it."
        href={DOCS_HREF}
      />
    </>
  );
}
