'use client';

import {
  ArrowsClockwiseIcon,
  ArrowsLeftRightIcon,
  CloudCheckIcon,
  CodeIcon,
  DatabaseIcon,
  HardDrivesIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { TABS, type PackageId } from '@/lib/packages';
import AnimatedHeadline from './AnimatedHeadline';
import { BentoIcon } from './BentoIcon';
import EvalsPrimitivesExplorer from './EvalsPrimitivesExplorer';
import EvalsRunVisual from './EvalsRunVisual';
import TracingPrimitivesExplorer from './TracingPrimitivesExplorer';
import TracingRunVisual from './TracingRunVisual';

interface BentoItem {
  icon: React.ReactNode | string;
  title: string;
  desc: React.ReactNode;
  code?: string;
  tag?: string;
}

function BentoItemIcon({ icon }: { icon: React.ReactNode | string }) {
  if (typeof icon === 'string') {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-lg leading-none">
        {icon}
      </span>
    );
  }
  return icon;
}

function InstallBlock({ pkg }: { pkg: string }) {
  return (
    <div className="install-block max-w-[400px]">
      <div className="install-block-hdr">
        <span>Terminal</span>
        <span>bash</span>
      </div>
      <div className="install-block-body">
        <div className="flex items-center gap-2">
          <span className="font-mono text-(--accent) transition-[color] duration-300">$</span>
          <span className="font-mono text-text-1">
            pnpm add <span className="text-(--accent) transition-[color] duration-300">{pkg}</span>
          </span>
        </div>
        <div className="flex items-center gap-2 pl-5">
          <span className="font-mono text-success">✓</span>
          <span className="font-mono text-success/85">Done in 0.4s</span>
          {pkg === '@m4trix/core' && <span className="font-mono text-text-4">Packages: +1</span>}
        </div>
      </div>
    </div>
  );
}

function BentoGrid({ items }: { items: BentoItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.title} className="bcard">
          <div className="bcard-hdr">
            <BentoItemIcon icon={item.icon} />
            <h3 className="bcard-title">{item.title}</h3>
          </div>
          <p className="text-[13px] leading-relaxed text-text-2">{item.desc}</p>
          {item.code ? <code className="bcard-code">{item.code}</code> : null}
          {item.tag ? <span className="bcard-tag">{item.tag}</span> : null}
        </div>
      ))}
    </div>
  );
}

function HeroGlow() {
  return (
    <>
      <div
        className="pointer-events-none absolute -top-[140px] left-[18%] h-[380px] w-[500px] rounded-full blur-[110px] transition-[background] duration-300"
        style={{ background: 'var(--glow-1)' }}
      />
      <div
        className="pointer-events-none absolute top-[35%] right-[16%] h-[280px] w-[360px] rounded-full blur-[110px] transition-[background] duration-300"
        style={{ background: 'var(--glow-2)' }}
      />
    </>
  );
}

const AGENT_BENTO: BentoItem[] = [
  {
    icon: '⚡',
    title: 'Event-Driven Agents',
    desc: 'Write a typed async function. Tell the factory which events trigger it and which it can emit. No base class, no decorator, no node to register — just logic and a schema.',
    code: 'AgentFactory.run().listensTo([evt]).logic(fn).produce({})',
    tag: 'core',
  },
  {
    icon: '🔗',
    title: 'Agent Networks',
    desc: (
      <>
        <code className="inline-code text-[11px]">setup()</code> is the only wiring ceremony.
        Subscribe an agent to a channel, tell it where to publish. Chain, fan-out, fork — always the
        same two lines.
      </>
    ),
    code: 'AgentNetwork.setup(({ registerAgent }) => …)',
    tag: 'core',
  },
  {
    icon: '🛡',
    title: 'Typed Events',
    desc: (
      <>
        The payload you emit in AgentA is the typed{' '}
        <code className="inline-code text-[11px]">triggerEvent</code> in AgentB. Effect Schema
        validates every handoff at runtime — a schema mismatch fails loudly, not silently in
        production.
      </>
    ),
    code: "AgentNetworkEvent.of('request', S.Struct({…}))",
    tag: 'typesafe',
  },
  {
    icon: '📡',
    title: 'SSE Streaming',
    desc: (
      <>
        Call <code className="inline-code text-[11px]">.expose()</code> on a network and you have a
        streaming HTTP endpoint. The Next.js adapter is a one-liner. Your frontend reads a
        Server-Sent Events stream, not a polling loop.
      </>
    ),
    code: 'NextEndpoint.from(network.expose({…})).handler()',
    tag: 'stream',
  },
  {
    icon: '🔀',
    title: 'Channels & Sinks',
    desc: (
      <>
        Channels are named message buses. Swap an{' '}
        <code className="inline-code text-[11px]">httpStream</code> sink for Kafka without touching
        a single agent. The agent doesn&apos;t know — or care — where its events go.
      </>
    ),
    code: "createChannel('client').sink(sink.httpStream())",
    tag: 'infra',
  },
  {
    icon: '📦',
    title: 'Batteries Included',
    desc: (
      <>
        <code className="inline-code text-[11px]">useConversation()</code> manages SSE state in
        React. <code className="inline-code text-[11px]">Pump</code> chains transforms over streams.{' '}
        <code className="inline-code text-[11px]">AiCursor</code> renders a live typing indicator.
        Nothing to assemble separately.
      </>
    ),
    code: '@m4trix/core  |  @m4trix/stream  |  @m4trix/react',
    tag: 'ecosystem',
  },
];

function AgentsSection() {
  return (
    <>
      <section className="relative z-[2] overflow-hidden py-20 pb-24 lg:py-[80px] lg:pb-24">
        <HeroGlow />
        <div className="relative z-[2] mx-auto max-w-7xl px-6 lg:px-8">
          <div className="flex flex-col items-center gap-12 lg:flex-row lg:items-center">
            <div className="flex-1 text-center lg:text-left">
              <p className="eyebrow">Agentic infrastructure</p>
              <AnimatedHeadline />
              <p className="mx-auto mt-4 max-w-[520px] text-[17px] leading-[1.65] text-text-2 lg:mx-0">
                Event-driven agent orchestration. Type-safe events, channels, sinks.{' '}
                <code className="inline-code">@m4trix/core/matrix</code>. Build, wire, stream.
              </p>
              <div className="mx-auto mt-6 lg:mx-0">
                <InstallBlock pkg="@m4trix/core" />
              </div>
              <div className="mt-4 flex flex-wrap justify-center gap-[7px] font-mono text-[11px] lg:justify-start">
                {[
                  { pkg: '@m4trix/core/matrix', desc: 'agents & networks' },
                  { pkg: '@m4trix/stream', desc: 'pipes' },
                  { pkg: '@m4trix/react', desc: 'hooks' },
                ].map((e) => (
                  <span key={e.pkg} className="entry-pill">
                    <span className="text-(--accent) transition-[color] duration-300">{e.pkg}</span>
                    <span className="ml-1.5 text-text-4">
                      {'// '}
                      {e.desc}
                    </span>
                  </span>
                ))}
              </div>
              <div className="mt-7 flex flex-wrap justify-center gap-3 lg:justify-start">
                <a href="https://docs.m4trix.dev" className="btn-primary group">
                  Quick Start
                  <span className="opacity-0 transition group-hover:opacity-100">→</span>
                </a>
                <a
                  href="https://github.com/Pascal-Lohscheidt/m4trix/stargazers"
                  className="btn-secondary"
                >
                  <svg
                    width="15"
                    height="15"
                    fill="var(--amber)"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                  >
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8-2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  Star on GitHub
                </a>
              </div>
            </div>
            <div className="w-full max-w-[260px] shrink-0">
              <div className="diagram-card">
                <p className="mb-3.5 text-center font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-4">
                  Agent network
                </p>
                <div className="flex flex-col gap-[7px]">
                  <div className="diagram-node">
                    <span className="diagram-node-dot" />
                    IngestAgent
                  </div>
                  <p className="text-center font-mono text-[11px] text-text-4">↓ events</p>
                  <div className="diagram-channel">channel(&apos;pipeline&apos;)</div>
                  <p className="text-center font-mono text-[11px] text-text-4">↓ sink</p>
                  <div className="diagram-node">
                    <span className="diagram-node-dot" />
                    TransformAgent
                  </div>
                  <p className="text-center font-mono text-[11px] text-text-4">↓ SSE</p>
                  <div className="diagram-channel">HTTP stream</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-12 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Write logic first. Wire it second.
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] text-text-2">
              Most frameworks make you draw a graph before you write a line of code. m4trix
              doesn&apos;t.
              <br />
              Agents declare what events they care about. The network figures out the rest at
              runtime.
            </p>
          </div>
          <p className="mx-auto mb-10 max-w-[640px] text-center text-sm leading-[1.7] text-text-3">
            The six primitives below compose into any topology — a linear chain, a fan-out, a
            multi-tenant swarm. You never redraw a graph when requirements change; you change which
            channel an agent subscribes to.
          </p>
          <BentoGrid items={AGENT_BENTO} />
        </div>
      </section>
    </>
  );
}

const EVALS_HIGHLIGHTS: BentoItem[] = [
  {
    icon: <BentoIcon icon={ShieldCheckIcon} />,
    title: 'Typesafe schemas',
    desc: 'Effect Schema validates datasets, evaluators, test cases, and scores at every boundary. Mismatches fail in CI — not silently in production.',
    tag: 'typesafe',
  },
  {
    icon: <BentoIcon icon={CodeIcon} />,
    title: 'Datasets in code, no lock-in',
    desc: 'Define datasets as TypeScript — filter by tag, path, or expression. No YAML ceremony, no proprietary format, no vendor cage.',
    tag: 'define',
  },
  {
    icon: <BentoIcon icon={ArrowsLeftRightIcon} />,
    title: 'Codegen & import',
    desc: 'Generate fixtures in any format you need, or import existing test cases from LangSmith, promptfoo, JSON, or other frameworks.',
    tag: 'codegen',
  },
  {
    icon: <BentoIcon icon={TerminalWindowIcon} />,
    title: 'CLI-first observability',
    desc: 'Run from the terminal in CI. Dump scores to Postgres, SQLite, or any sink adapter — visualize with Grafana or Metabase.',
    tag: 'cli',
  },
  {
    icon: <BentoIcon icon={CloudCheckIcon} />,
    title: 'Free & self-hosted',
    desc: 'MIT licensed, no seat fees. Deploy on any cloud or run in CI/CD — your eval data stays in infrastructure you control.',
    tag: 'infra',
  },
];

function EvalsSection() {
  return (
    <>
      <section className="relative z-[2] overflow-hidden py-20 pb-24 lg:py-[80px] lg:pb-24">
        <HeroGlow />
        <div className="relative z-[2] mx-auto max-w-7xl px-6 lg:px-8">
          <div className="flex flex-col items-center gap-12 lg:flex-row lg:items-center">
            <div className="flex-1 text-center lg:text-left">
              <p className="eyebrow">@m4trix/evals</p>
              <h1 className="font-display text-[clamp(2.25rem,6vw,4rem)] font-bold tracking-[-0.025em] leading-[1.1] text-text-1">
                Repeatable evals for{' '}
                <span className="text-(--accent) transition-[color] duration-300">AI agents</span>
              </h1>
              <p className="mx-auto mt-4 max-w-[580px] text-[17px] leading-[1.65] text-text-2 lg:mx-0">
                Define datasets, evaluators, and test cases as TypeScript files. The CLI discovers
                and runs them by convention — like Vitest, but for your AI outputs.
              </p>
              <div className="mt-[18px] flex flex-wrap justify-center gap-[7px] lg:justify-start">
                {['*.dataset.ts', '*.evaluator.ts', '*.run-config.ts', '*.test-case.ts'].map(
                  (f) => (
                    <span key={f} className="convention-pill">
                      {f}
                    </span>
                  ),
                )}
              </div>
              <div className="mx-auto mt-6 lg:mx-0">
                <InstallBlock pkg="@m4trix/evals" />
              </div>
              <div className="mt-7 flex flex-wrap justify-center gap-3 lg:justify-start">
                <a href="https://docs.m4trix.dev/evals" className="btn-primary group">
                  Get Started
                  <span className="opacity-0 transition group-hover:opacity-100">→</span>
                </a>
                <a href="https://github.com/Pascal-Lohscheidt/m4trix" className="btn-secondary">
                  View on GitHub
                </a>
              </div>
            </div>
            <div className="w-full max-w-[280px] shrink-0">
              <EvalsRunVisual />
            </div>
          </div>
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-16 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-10 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Built different from cloud eval platforms
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] text-text-2">
              Typesafe by default, defined in code, portable across tools — and free to run anywhere
              you deploy.
            </p>
          </div>
          <BentoGrid items={EVALS_HIGHLIGHTS} />
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-12 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Name your cases. Score every change.
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] leading-relaxed text-text-2">
              Hand-rolled evals don&apos;t survive the next model swap or the next engineer. Put
              inputs, scorers, and run configs in TypeScript so every iteration gets a number you
              can compare—and a command you can rerun tomorrow.
            </p>
          </div>
          <EvalsPrimitivesExplorer />
        </div>
      </section>
    </>
  );
}

const TRACING_HIGHLIGHTS: BentoItem[] = [
  {
    icon: <BentoIcon icon={PlugsConnectedIcon} />,
    title: 'Drop-in adapter',
    desc: 'Already on LangGraph or LangChain? Pass the tracer to callbacks — one line to capture every model call, tool invocation, and chain step.',
    tag: 'adapter',
  },
  {
    icon: <BentoIcon icon={DatabaseIcon} />,
    title: 'Split storage',
    desc: 'Structure rows hold metadata, timing, and status. Payload blobs store prompts and completions by ref — query the small stuff fast, fetch the large stuff only when you need it.',
    tag: 'storage',
  },
  {
    icon: <BentoIcon icon={HardDrivesIcon} />,
    title: 'Local-first',
    desc: 'Traces land in ./.traces on your machine by default. No sign-up, no API key, no upload queue — grep them, mount them, or open them in the trace viewer.',
    tag: 'local',
  },
  {
    icon: <BentoIcon icon={ArrowsClockwiseIcon} />,
    title: 'Same store reads back',
    desc: 'The adapter that writes traces serves them back through TraceViewerApi. Reconstruct span trees and resolve payloads — no read replica or sync lag.',
    tag: 'api',
  },
  {
    icon: <BentoIcon icon={CloudCheckIcon} />,
    title: 'Pluggable backends',
    desc: 'Filesystem out of the box. Swap in S3 payload and DynamoDB structure adapters for production — same Tracer and TraceViewerApi surface.',
    tag: 'infra',
  },
];

function TracingSection() {
  return (
    <>
      <section className="relative z-[2] overflow-hidden py-20 pb-24 lg:py-[80px] lg:pb-24">
        <HeroGlow />
        <div className="relative z-[2] mx-auto max-w-7xl px-6 lg:px-8">
          <div className="flex flex-col items-center gap-12 lg:flex-row lg:items-center">
            <div className="flex-1 text-center lg:text-left">
              <p className="eyebrow">@m4trix/tracing</p>
              <h1 className="font-display text-[clamp(2.25rem,6vw,4rem)] font-bold tracking-[-0.025em] leading-[1.1] text-text-1">
                Trace your agents.
                <br />
                <span className="text-(--accent) transition-[color] duration-300">
                  No cloud needed.
                </span>
              </h1>
              <p className="mx-auto mt-4 max-w-[520px] text-[17px] leading-[1.65] text-text-2 lg:mx-0">
                A lightweight LangGraph/LangChain-compatible tracer. Structure stored separately
                from payloads. Works locally, on Docker, or with custom storage adapters.
              </p>
              <div className="mx-auto mt-6 lg:mx-0">
                <InstallBlock pkg="@m4trix/tracing" />
              </div>
              <div className="mt-7 flex flex-wrap justify-center gap-3 lg:justify-start">
                <a href="https://docs.m4trix.dev/tracing" className="btn-primary group">
                  Get Started
                  <span className="opacity-0 transition group-hover:opacity-100">→</span>
                </a>
                <a href="https://github.com/Pascal-Lohscheidt/m4trix" className="btn-secondary">
                  View on GitHub
                </a>
              </div>
            </div>
            <div className="w-full max-w-[280px] shrink-0">
              <TracingRunVisual />
            </div>
          </div>
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-16 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-10 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Built different from cloud trace platforms
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] text-text-2">
              Split storage, local by default, and adapters you own — no seat fees, no per-token
              upload tax, no vendor lock-in.
            </p>
          </div>
          <BentoGrid items={TRACING_HIGHLIGHTS} />
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-24 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-12 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Wire callbacks once. Read traces anywhere.
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] leading-relaxed text-text-2">
              Capture LangGraph and LangChain spans to a folder you control. Query structure rows
              for lists and filters; resolve payload refs only when you open a run — locally, in
              Docker, or against S3 and DynamoDB adapters.
            </p>
          </div>
          <TracingPrimitivesExplorer />
        </div>
      </section>
    </>
  );
}

interface PackageTabsProps {
  active: PackageId;
  onChange: (pkg: PackageId) => void;
}

export default function PackageTabs({ active, onChange }: PackageTabsProps) {
  return (
    <>
      <div
        className="sticky top-14 z-40 border-b backdrop-blur-md transition-[border-color,background] duration-300"
        style={{
          borderColor: 'var(--border)',
          background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
        }}
        role="tablist"
      >
        <div className="mx-auto flex max-w-7xl overflow-x-auto px-6 lg:px-8">
          {TABS.map((tab) => {
            const isActive = active === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onChange(tab.id)}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-[18px] py-3.5 font-mono text-[13px] font-medium whitespace-nowrap transition-[color,border-color] duration-300 ${
                  isActive
                    ? 'border-(--accent) text-text-1'
                    : 'border-transparent text-text-4 hover:text-text-2'
                }`}
              >
                {tab.label}
                {tab.badge && (
                  <span className={`tab-pill ${isActive ? 'tab-pill-active' : ''}`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div role="tabpanel">
        {active === 'agents' && <AgentsSection />}
        {active === 'evals' && <EvalsSection />}
        {active === 'tracing' && <TracingSection />}
      </div>
    </>
  );
}
