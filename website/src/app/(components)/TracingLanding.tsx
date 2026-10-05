'use client';

import {
  ArrowRightIcon,
  CloudArrowUpIcon,
  FolderSimpleIcon,
  PlusIcon,
  ShippingContainerIcon,
} from '@phosphor-icons/react';
import Image from 'next/image';
import {
  siClaude,
  siCursor,
  siDocker,
  siGithub,
  siKubernetes,
  siLangchain,
  siLanggraph,
  siModelcontextprotocol,
} from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import type { PackageId } from '@/lib/packages';
import CodeBlock from './CodeBlock';
import CopyCommand from './CopyCommand';
import TracingPrimitivesExplorer from './TracingPrimitivesExplorer';

const DOCS_HREF = 'https://docs.m4trix.dev/tracing';
const GITHUB_HREF = 'https://github.com/Pascal-Lohscheidt/m4trix';

function Section({
  id,
  className = '',
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative z-[2] px-4 py-16 sm:px-6 sm:py-20 lg:px-8 ${className}`.trim()}
    >
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

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
            Trace your agents. <span className="text-(--accent) sm:block">No cloud needed.</span>
          </h1>
          <p
            className="rise-in mt-6 max-w-[54ch] text-[17px] leading-relaxed text-text-2 sm:text-lg"
            style={{ '--rise-delay': '120ms' } as React.CSSProperties}
          >
            Open-source tracing for LangGraph and LangChain. Traces stay in your files or your AWS
            account, with a viewer you run.
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

function WorksWith() {
  return (
    <div className="relative z-[2] px-4 pt-6 pb-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <p className="text-center text-sm text-text-3">Fits the stack you already run</p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
          {STACK.map((icon) => (
            <li
              key={icon.slug}
              className="flex items-center gap-2.5 text-text-3 transition-colors hover:text-text-1"
            >
              <BrandIcon icon={icon} />
              <span className="text-sm font-medium">{icon.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
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

const QUICKSTART_STEPS = [
  {
    title: 'Install the package',
    body: 'The root entry has no runtime dependencies.',
  },
  {
    title: 'Pass the tracer as a callback',
    body: 'Every chain, model, tool and retriever call lands in ./.traces. Your graph code stays as it is.',
  },
  {
    title: 'Open the viewer',
    body: 'One command serves the run tree, payloads and annotations on localhost.',
  },
];

function Quickstart() {
  return (
    <Section id="quickstart">
      <div className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div>
          <h2 className="lp-h2">From callback to run tree in one file</h2>
          <p className="lp-lead">
            The tracer speaks the LangChain callback API, so adding it is a config change, not a
            rewrite.
          </p>
          <ol className="mt-10 flex flex-col gap-7">
            {QUICKSTART_STEPS.map((step, i) => (
              <li key={step.title} className="grid grid-cols-[2rem_1fr] gap-x-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-(--accent-border) bg-(--accent-dim) font-mono text-[13px] font-semibold text-(--accent)">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-display text-[17px] font-semibold text-text-1">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-text-2">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <CodeBlock
            className="agent-code-block"
            code="pnpm add @m4trix/tracing"
            language="bash"
            filename="terminal"
          />
          <CodeBlock
            className="agent-code-block"
            code={QUICKSTART_CODE}
            language="typescript"
            filename="agent.ts"
          />
          <CodeBlock
            className="agent-code-block"
            code="npx m4trix-trace-viewer --adapter fs --path ./.traces"
            language="bash"
            filename="terminal"
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
      <h2 className="lp-h2 max-w-2xl">Read an agent run the way you read code</h2>
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
            <span className="text-(--accent)">└─ f19bca0d…/</span>
            <br />
            &nbsp;&nbsp;&nbsp;├─ trace.json
            <br />
            &nbsp;&nbsp;&nbsp;├─ runs.ndjson
            <br />
            &nbsp;&nbsp;&nbsp;└─ payloads/
          </div>
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">Split storage</h3>
          <p className="bento-body">
            Structure rows hold timing, status and tokens. Prompts and completions are blobs,
            fetched by ref only when you open a span.
          </p>
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">Review in place</h3>
          <p className="bento-body">
            Annotate traces and single runs after the fact. Notes live next to the structure rows,
            not in another tool.
          </p>
          <code className="mono-panel mt-5 block text-(--cyan)">
            {"annotation: { review: 'approved' }"}
          </code>
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">One store, both directions</h3>
          <p className="bento-body">
            The adapters that write a trace also serve it back through TraceViewerApi. No read
            replica, no sync lag.
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ─── MCP ─────────────────────────────────────────────────────────────── */

const MCP_GROUPS = [
  {
    title: 'Find',
    tools: ['list_traces', 'find_runs', 'search_payloads', 'load_trace_payloads'],
  },
  {
    title: 'Inspect',
    tools: ['get_trace', 'get_run', 'get_payload', 'get_conversation'],
  },
  {
    title: 'Diagnose',
    tools: ['analyze_trace', 'compare', 'annotate'],
  },
];

function McpSection() {
  return (
    <Section>
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="min-w-0">
          <div className="flex items-center gap-3 text-text-3">
            <BrandIcon icon={siModelcontextprotocol} className="h-6 w-6" />
            <BrandIcon icon={siClaude} className="h-6 w-6" />
            <BrandIcon icon={siCursor} className="h-6 w-6" />
          </div>
          <h2 className="lp-h2 mt-6">Hand the trace to your coding agent</h2>
          <p className="lp-lead">
            The viewer also runs as an MCP server. Claude Code, Cursor or any MCP client can search
            payloads, find the root cause of an error and diff two runs.
          </p>
          <CodeBlock
            className="agent-code-block mt-8"
            code={
              'claude mcp add m4trix-traces -- \\\n  npx m4trix-trace-viewer mcp --path "$PWD/.traces"'
            }
            language="bash"
            filename="terminal"
          />
        </div>

        <div className="min-w-0 rounded-xl border border-(--border) bg-[color-mix(in_srgb,var(--bg-raised)_45%,transparent)] p-6 sm:p-8">
          <p className="font-display text-[17px] font-semibold text-text-1">
            11 tools, read-only unless you approve a note
          </p>
          <div className="mt-6 flex flex-col gap-6">
            {MCP_GROUPS.map((group) => (
              <div key={group.title}>
                <p className="text-sm font-medium text-text-3">{group.title}</p>
                <ul className="mt-2.5 flex flex-wrap gap-2">
                  {group.tools.map((tool) => (
                    <li key={tool} className="tool-chip">
                      {tool}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-7 border-t border-(--border) pt-5 text-[15px] leading-relaxed text-text-2">
            <code className="inline-code">analyze_trace</code> flags error roots, unfinished runs,
            the critical path, token hotspots and loops in one call.
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ─── Deploy path ─────────────────────────────────────────────────────── */

const DEPLOY_STAGES = [
  {
    icon: FolderSimpleIcon,
    title: 'On your laptop',
    body: 'Filesystem adapters write to ./.traces. Open them with the viewer CLI.',
    code: '--adapter fs --path ./.traces',
  },
  {
    icon: ShippingContainerIcon,
    title: 'In your cluster',
    body: 'The app writes to a shared volume. A sidecar ships it, so the app needs no AWS credentials.',
    code: 'm4trix-tracing-sidecar --root /traces',
  },
  {
    icon: CloudArrowUpIcon,
    title: 'In your AWS account',
    body: 'Structure goes to DynamoDB, payloads to S3. The same viewer reads it back.',
    code: '--adapter aws-stack',
  },
];

function DeployPath() {
  return (
    <Section>
      <h2 className="lp-h2 max-w-2xl">Start on a laptop. Ship to AWS when you need to.</h2>
      <p className="lp-lead">Same Tracer, same viewer at every stage. Only the adapters change.</p>

      <ol className="mt-12 grid overflow-hidden rounded-xl border border-(--border-md) lg:grid-cols-3">
        {DEPLOY_STAGES.map((stage, i) => {
          const StageIcon = stage.icon;
          return (
            <li
              key={stage.title}
              className={`relative flex flex-col p-6 sm:p-8 ${
                i > 0 ? 'border-t border-(--border-md) lg:border-t-0 lg:border-l' : ''
              }`}
              style={{
                background:
                  i === 2
                    ? 'linear-gradient(160deg, var(--accent-dim), transparent 70%)'
                    : 'color-mix(in srgb, var(--bg-raised) 40%, transparent)',
              }}
            >
              <StageIcon aria-hidden className="h-6 w-6 text-(--accent)" />
              <h3 className="mt-5 font-display text-lg font-semibold text-text-1">{stage.title}</h3>
              <p className="mt-2 flex-1 text-[15px] leading-relaxed text-text-2">{stage.body}</p>
              <code className="mt-6 block truncate font-mono text-[12px] text-text-3">
                {stage.code}
              </code>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

/* ─── API explorer ────────────────────────────────────────────────────── */

function ApiExplorer() {
  return (
    <Section>
      <h2 className="lp-h2">Six primitives. That is the whole API.</h2>
      <p className="lp-lead mb-12">Swap any adapter without touching the tracer or the viewer.</p>
      <TracingPrimitivesExplorer />
    </Section>
  );
}

/* ─── FAQ ─────────────────────────────────────────────────────────────── */

const FAQ = [
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

function Faq() {
  return (
    <Section>
      <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
        <h2 className="lp-h2">Questions</h2>
        <div className="border-t border-(--border)">
          {FAQ.map((item) => (
            <details key={item.q} className="faq-item group">
              <summary>
                {item.q}
                <PlusIcon aria-hidden className="faq-icon h-5 w-5" />
              </summary>
              <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-text-2">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ─── Rest of the toolkit ─────────────────────────────────────────────── */

const SIBLINGS: { id: PackageId; name: string; title: string; body: string }[] = [
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

function Toolkit({ onSelectPackage }: { onSelectPackage: (pkg: PackageId) => void }) {
  return (
    <Section>
      <h2 className="lp-h2">Part of the m4trix toolkit</h2>
      <p className="lp-lead">
        Each package works on its own. Together they share one TypeScript model.
      </p>
      <div className="mt-10 grid gap-4 md:grid-cols-2">
        {SIBLINGS.map((pkg) => (
          <button
            key={pkg.id}
            type="button"
            onClick={() => onSelectPackage(pkg.id)}
            className="group bento-cell cursor-pointer text-left transition-[border-color] hover:border-(--accent-border)"
          >
            <span className="font-mono text-[13px] text-text-3">{pkg.name}</span>
            <span className="mt-3 flex items-center gap-2 font-display text-xl font-semibold text-text-1">
              {pkg.title}
              <ArrowRightIcon
                aria-hidden
                className="h-4 w-4 text-text-3 transition-transform group-hover:translate-x-0.5"
                weight="bold"
              />
            </span>
            <span className="bento-body">{pkg.body}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/* ─── Closing CTA ─────────────────────────────────────────────────────── */

function ClosingCta() {
  return (
    <section className="relative z-[2] px-4 pt-6 pb-20 sm:px-6 lg:px-8">
      <div
        className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-(--accent-border) px-6 py-16 text-center sm:px-12"
        style={{
          background:
            'radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 65%), color-mix(in srgb, var(--bg-raised) 60%, transparent)',
        }}
      >
        <h2 className="lp-h2 mx-auto max-w-xl">Add tracing before your next run</h2>
        <p className="mx-auto mt-4 max-w-[46ch] text-base leading-relaxed text-text-2">
          One callback, one folder, one command to open it.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href={DOCS_HREF} className="btn-primary group">
            Get started
            <ArrowRightIcon
              aria-hidden
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              weight="bold"
            />
          </a>
          <a href={GITHUB_HREF} className="btn-secondary">
            <BrandIcon icon={siGithub} className="h-4 w-4" />
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

export default function TracingLanding({
  onSelectPackage,
}: {
  onSelectPackage: (pkg: PackageId) => void;
}) {
  return (
    <>
      <Hero />
      <WorksWith />
      <Quickstart />
      <Bento />
      <McpSection />
      <DeployPath />
      <ApiExplorer />
      <Faq />
      <Toolkit onSelectPackage={onSelectPackage} />
      <ClosingCta />
    </>
  );
}
