'use client';

import {
  ArrowsLeftRightIcon,
  CloudCheckIcon,
  CodeIcon,
  ShieldCheckIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import type { PackageId } from '@/lib/packages';
import AnimatedHeadline from './AnimatedHeadline';
import { BentoIcon } from './BentoIcon';
import CodeBlock from './CodeBlock';
import EvalsPrimitivesExplorer from './EvalsPrimitivesExplorer';
import EvalsRunVisual from './EvalsRunVisual';
import TracingLanding from './TracingLanding';

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
    <div className="install-block w-full max-w-[400px]">
      <div className="install-block-hdr">
        <span>Terminal</span>
        <span>bash</span>
      </div>
      <div className="install-block-body">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-(--accent) transition-[color] duration-300">$</span>
          <span className="min-w-0 font-mono text-text-1">
            pnpm add <span className="text-(--accent) transition-[color] duration-300">{pkg}</span>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-5">
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

const AGENT_PROOF_POINTS = [
  { value: 'Typed', label: 'Events infer through every handler.' },
  { value: 'Schema', label: 'Runtime validation at boundaries.' },
  { value: 'Channels', label: 'Producers and sinks stay decoupled.' },
  { value: 'SSE', label: 'Streaming endpoints without glue code.' },
];

const AGENT_FLOW_POINTS = [
  {
    label: '1. Event',
    title: 'Declare what happened',
    body: 'Events carry schemas, so every agent receives a known payload shape.',
  },
  {
    label: '2. Handler',
    title: 'Write the business logic',
    body: 'Agents are async functions. No graph nodes, decorators, or shared state object.',
  },
  {
    label: '3. Channel',
    title: 'Publish the result',
    body: 'Send output to a named channel and swap the downstream sink whenever you need.',
  },
];

const LANGGRAPH_CODE = `from langgraph.graph import StateGraph, START, END

class State(TypedDict):
    messages: Annotated[list, add_messages]

def call_model(state: State):
    return {"messages": [llm.invoke(state["messages"])]}

builder = StateGraph(State)
builder.add_node("llm", call_model)
builder.add_edge(START, "llm")
builder.add_edge("llm", END)
graph = builder.compile()  # required before invoke`;

const M4TRIX_CODE = `const UserQuery = AgentNetworkEvent.of(
  'user:query',
  S.Struct({ query: S.String })
)

const llmAgent = AgentFactory.run()
  .listensTo([UserQuery])
  .logic(async ({ event }) => ({
    reply: await openai.chat(event.payload.query)
  }))
  .produce({ channel: 'client' })

AgentNetwork.setup(({ registerAgent }) => {
  registerAgent(llmAgent)
})`;

const AGENT_STEPS = [
  {
    title: 'Define events',
    body: 'Name the input once and keep inference through the whole pipeline.',
    code: `AgentNetworkEvent.of('user:query', S.Struct({
  query: S.String,
}))`,
  },
  {
    title: 'Write logic',
    body: 'Handle the event with a plain async function. Return typed output.',
    code: `AgentFactory.run()
  .listensTo([UserQuery])
  .logic(async ({ event }) => ({
    reply: await llm(event.payload.query)
  }))`,
  },
  {
    title: 'Wire the network',
    body: 'Register agents and expose a channel as HTTP, SSE, or another sink.',
    code: `AgentNetwork.setup(({ registerAgent }) => {
  registerAgent(llmAgent)
}).expose({ channel: 'client' })`,
  },
];

const AGENT_FEATURES = [
  {
    eyebrow: 'Core primitive',
    title: 'Agents are just typed handlers',
    desc: 'Keep orchestration out of your business logic. Handlers listen to events and publish output.',
    code: `AgentFactory.run()
  .listensTo([UserQuery])
  .logic(handler)
  .produce({ channel: 'client' })`,
    visual: 'Graphic placeholder: show one event flowing into a handler and out to a channel.',
    size: 'lg:col-span-2',
  },
  {
    eyebrow: 'Type safety',
    title: 'Schemas travel with events',
    desc: 'Effect Schema validates external input while TypeScript keeps handler payloads inferred.',
    code: `AgentNetworkEvent.of('user:query', S.Struct({
  query: S.String,
}))`,
  },
  {
    eyebrow: 'Scale path',
    title: 'Start with one agent. Add more later.',
    desc: 'Networks let agents share channels without a global state object or graph rewrite.',
    code: `AgentNetwork.setup(({ registerAgent }) => {
  registerAgent(llmAgent)
  registerAgent(toolAgent)
})`,
  },
  {
    eyebrow: 'Routing',
    title: 'Channels decouple every boundary',
    desc: 'Change where events go without changing the agent that produced them.',
    code: `createChannel('client').sink(sink.httpStream())`,
    visual: 'Graphic placeholder: route picker showing HTTP, Kafka, and custom sink options.',
  },
  {
    eyebrow: 'Adapters',
    title: 'Streaming HTTP is built in',
    desc: 'Expose a network as SSE from Next.js or Express without hand-rolled stream plumbing.',
    code: `NextEndpoint.from(
  network.expose({ channel: 'client' })
).handler()`,
  },
  {
    eyebrow: 'Ecosystem',
    title: 'One model across the stack',
    desc: 'Core, stream, React hooks, and UI pieces use the same event vocabulary.',
    code: `// @m4trix/core · @m4trix/stream
// @m4trix/react · @m4trix/ui`,
    visual: 'Graphic placeholder: stack diagram from core to stream to React UI.',
  },
];

function AgentsPanelSection({
  title,
  children,
  description,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  description?: string;
  className?: string;
}) {
  return (
    <section className={`relative z-[2] px-4 pb-20 sm:px-6 sm:pb-24 lg:px-8 ${className}`.trim()}>
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <h2 className="agent-section-title">{title}</h2>
          {description ? <p className="agent-section-desc">{description}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

function AgentsProofStrip() {
  return (
    <div className="relative z-[2] mx-auto max-w-6xl px-6 pb-20">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {AGENT_PROOF_POINTS.map((point) => (
          <div key={point.value} className="agent-stat-card">
            <p className="font-display text-xl font-semibold text-(--accent)">{point.value}</p>
            <p className="mt-2 text-sm leading-relaxed text-text-2">{point.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function GraphicPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="agent-graphic-placeholder">
      <span className="agent-placeholder-label">Graphic placeholder</span>
      <p>{children}</p>
    </div>
  );
}

function AgentOperatingModel() {
  return (
    <AgentsPanelSection
      title="A small model that scales"
      description="m4trix keeps the mental model compact: events describe data, agents handle work, channels route output."
    >
      <div className="grid items-stretch gap-6 lg:grid-cols-[1fr_0.85fr]">
        <div className="agent-feature-card gap-5">
          {AGENT_FLOW_POINTS.map((point) => (
            <div key={point.label} className="flex gap-4">
              <span className="mt-1 h-fit rounded-full border border-(--accent-border) bg-(--accent-dim) px-3 py-1 font-mono text-[11px] font-semibold text-(--accent)">
                {point.label}
              </span>
              <div>
                <h3 className="font-display text-lg font-semibold text-text-1">{point.title}</h3>
                <p className="mt-1 text-[15px] leading-relaxed text-text-2">{point.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="hidden sm:block">
          <GraphicPlaceholder>
            Animated product graphic: browser request enters an event, passes through an agent, then
            fans out to HTTP stream and Kafka/custom sink.
          </GraphicPlaceholder>
        </div>
      </div>
    </AgentsPanelSection>
  );
}

function AgentTradeoff() {
  return (
    <AgentsPanelSection
      title="What changes compared to graph frameworks"
      description="You still get orchestration, but the unit of composition is an event contract instead of a hand-wired graph."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ['Before logic', 'No state graph to model before the first handler exists.'],
          ['While building', 'Handlers stay independent and communicate through named channels.'],
          ['When shipping', 'Expose the same network through SSE, HTTP, Kafka, or your own sink.'],
        ].map(([title, body]) => (
          <div key={title} className="agent-stat-card">
            <h3 className="font-display text-lg font-semibold text-text-1">{title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-text-2">{body}</p>
          </div>
        ))}
      </div>
    </AgentsPanelSection>
  );
}

function CodeComparison() {
  return (
    <AgentsPanelSection
      title="No graphs. Just events."
      description="Same outcome: query in, LLM out. Far less ceremony."
      className="hidden sm:block"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="agent-comparison-card">
          <p className="mb-3 font-display text-sm font-semibold text-text-3">Graph-first</p>
          <CodeBlock
            className="agent-code-block"
            code={LANGGRAPH_CODE}
            language="python"
            filename="agent.py"
          />
        </div>
        <div className="agent-comparison-card agent-comparison-card-accent">
          <p className="mb-3 font-display text-sm font-semibold text-(--accent)">Event-first</p>
          <CodeBlock
            className="agent-code-block"
            code={M4TRIX_CODE}
            language="typescript"
            filename="agent.ts"
          />
        </div>
      </div>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <p
          className="rounded-lg border px-4 py-3 text-sm leading-relaxed text-text-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="mr-2 text-(--red)">✗</span>
          State, nodes, edges, and a compile step before your first invoke.
        </p>
        <p
          className="rounded-lg border px-4 py-3 text-sm leading-relaxed text-text-2"
          style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-dim)' }}
        >
          <span className="mr-2 text-success">✓</span>
          Define the event, write the handler, register the agent. TypeScript catches bad shapes.
        </p>
      </div>
    </AgentsPanelSection>
  );
}

function AgentSteps() {
  return (
    <AgentsPanelSection
      title="The workflow fits in three files"
      description="Each layer has one job: define the contract, implement the handler, register the network."
      className="hidden sm:block"
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {AGENT_STEPS.map((step, index) => (
          <div key={step.title} className="agent-feature-card">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full border font-display text-sm font-bold text-(--accent)"
              style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-dim)' }}
            >
              {index + 1}
            </span>
            <h3 className="font-display text-lg font-semibold text-text-1">{step.title}</h3>
            <p className="text-[15px] leading-relaxed text-text-2">{step.body}</p>
            <CodeBlock
              className="agent-code-block mt-auto"
              code={step.code}
              language="typescript"
            />
          </div>
        ))}
      </div>
    </AgentsPanelSection>
  );
}

function MobileAgentSummary() {
  return (
    <AgentsPanelSection
      title="What you get"
      description="The full code examples are available on larger screens. On mobile, the important part is the shape of the system."
      className="sm:hidden"
    >
      <div className="grid gap-4">
        {[
          [
            'Typed contracts',
            'Events define the payload once and carry inference into each handler.',
          ],
          [
            'Plain handlers',
            'Agent logic stays as async TypeScript functions instead of graph nodes.',
          ],
          [
            'Swappable outputs',
            'Channels let you route results to SSE, HTTP, Kafka, or custom sinks.',
          ],
        ].map(([title, body], index) => (
          <div key={title} className="agent-feature-card">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full border font-display text-sm font-bold text-(--accent)"
              style={{ borderColor: 'var(--accent-border)', background: 'var(--accent-dim)' }}
            >
              {index + 1}
            </span>
            <h3 className="font-display text-lg font-semibold text-text-1">{title}</h3>
            <p className="text-[15px] leading-relaxed text-text-2">{body}</p>
          </div>
        ))}
      </div>
    </AgentsPanelSection>
  );
}

function AgentFeatureGrid() {
  return (
    <AgentsPanelSection
      title="Production pieces without new concepts"
      description="The same event and channel model covers local agents, streamed responses, and downstream infrastructure."
      className="hidden sm:block"
    >
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {AGENT_FEATURES.map((feature) => (
          <div key={feature.title} className={`agent-feature-card ${feature.size ?? ''}`}>
            <span className="font-mono text-[11px] font-semibold tracking-widest text-(--accent) uppercase">
              {feature.eyebrow}
            </span>
            <h3 className="font-display text-xl font-semibold text-text-1">{feature.title}</h3>
            <p className="text-[15px] leading-relaxed text-text-2">{feature.desc}</p>
            {feature.visual ? <GraphicPlaceholder>{feature.visual}</GraphicPlaceholder> : null}
            <CodeBlock
              className="agent-code-block mt-auto"
              code={feature.code}
              language="typescript"
            />
          </div>
        ))}
      </div>
    </AgentsPanelSection>
  );
}

function AgentsPanel() {
  return (
    <>
      <AgentsProofStrip />
      <AgentOperatingModel />
      <AgentTradeoff />
      <MobileAgentSummary />
      <CodeComparison />
      <AgentSteps />
      <AgentFeatureGrid />
    </>
  );
}

function AgentsSection() {
  return (
    <>
      <section className="relative z-[2] overflow-hidden py-12 pb-12 sm:py-20 sm:pb-24 lg:py-[80px] lg:pb-24">
        <HeroGlow />
        <div className="relative z-[2] mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center gap-8 sm:gap-12 lg:flex-row lg:items-center">
            <div className="flex-1 text-center lg:text-left">
              <p className="eyebrow">Agentic infrastructure</p>
              <AnimatedHeadline />
              <p className="mx-auto mt-4 max-w-[520px] text-[15px] leading-[1.65] text-text-2 sm:text-[17px] lg:mx-0">
                Event-driven agent orchestration. Type-safe events, channels, proxies.{' '}
                <code className="inline-code">@m4trix/core/matrix</code>. Build, wire, stream.
              </p>
              <div className="mx-auto mt-6 max-w-[400px] lg:mx-0">
                <InstallBlock pkg="@m4trix/core" />
              </div>
              <div className="mx-auto mt-4 hidden max-w-[320px] flex-wrap justify-center gap-[7px] font-mono text-[11px] sm:flex sm:max-w-none lg:mx-0 lg:justify-start">
                {[
                  { pkg: '@m4trix/core/matrix', desc: 'agents & networks' },
                  { pkg: '@m4trix/stream', desc: 'pipes' },
                  { pkg: '@m4trix/react', desc: 'hooks' },
                ].map((e) => (
                  <span key={e.pkg} className="entry-pill">
                    <span className="text-(--accent) transition-[color] duration-300">{e.pkg}</span>
                    <span className="ml-1.5 hidden text-text-4 sm:inline">
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
                  className="btn-secondary hidden sm:inline-flex"
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
            <div className="hidden w-full max-w-[260px] shrink-0 sm:block">
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
                  <p className="text-center font-mono text-[11px] text-text-4">↓ proxy</p>
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
      <AgentsPanel />
    </>
  );
}

const EVALS_HIGHLIGHTS: BentoItem[] = [
  {
    icon: <BentoIcon icon={ShieldCheckIcon} />,
    title: 'Typesafe schemas',
    desc: 'Effect Schema validates datasets, evaluators, test cases, and scores at every boundary. Mismatches fail in CI, not silently in production.',
    tag: 'typesafe',
  },
  {
    icon: <BentoIcon icon={CodeIcon} />,
    title: 'Datasets in code, no lock-in',
    desc: 'Define datasets as TypeScript. Filter by tag, path, or expression. No YAML ceremony, no proprietary format, no vendor cage.',
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
    desc: 'Run from the terminal in CI. Dump scores to Postgres, SQLite, or any sink adapter, then visualize with Grafana or Metabase.',
    tag: 'cli',
  },
  {
    icon: <BentoIcon icon={CloudCheckIcon} />,
    title: 'Free & self-hosted',
    desc: 'MIT licensed, no seat fees. Deploy on any cloud or run in CI/CD. Your eval data stays in infrastructure you control.',
    tag: 'infra',
  },
];

function EvalsSection() {
  return (
    <>
      <section className="relative z-[2] overflow-hidden py-12 pb-12 sm:py-20 sm:pb-24 lg:py-[80px] lg:pb-24">
        <HeroGlow />
        <div className="relative z-[2] mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center gap-8 sm:gap-12 lg:flex-row lg:items-center">
            <div className="flex-1 text-center lg:text-left">
              <p className="eyebrow">@m4trix/evals</p>
              <h1 className="font-display text-[clamp(2.25rem,6vw,4rem)] font-bold tracking-[-0.025em] leading-[1.1] text-text-1">
                Repeatable evals for{' '}
                <span className="text-(--accent) transition-[color] duration-300">AI agents</span>
              </h1>
              <p className="mx-auto mt-4 max-w-[580px] text-[15px] leading-[1.65] text-text-2 sm:text-[17px] lg:mx-0">
                Define datasets, evaluators, and test cases as TypeScript files. The CLI discovers
                and runs them by convention, like Vitest, but for your AI outputs.
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
              <div className="mx-auto mt-6 max-w-[400px] lg:mx-0">
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
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Built different from cloud eval platforms
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] text-text-2">
              Typesafe by default, defined in code, portable across tools, and free to run anywhere
              you deploy.
            </p>
          </div>
          <BentoGrid items={EVALS_HIGHLIGHTS} />
        </div>
      </section>
      <section className="relative z-[2] px-6 pb-24 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 text-center">
            <h2 className="font-display text-[clamp(1.5rem,4vw,2.25rem)] font-bold tracking-[-0.02em] text-text-1">
              Name your cases. Score every change.
            </h2>
            <p className="mx-auto mt-2.5 max-w-2xl text-[15px] leading-relaxed text-text-2">
              Hand-rolled evals don&apos;t survive the next model swap or the next engineer. Put
              inputs, scorers, and run configs in TypeScript so every iteration gets a number you
              can compare, and a command you can rerun tomorrow.
            </p>
          </div>
          <EvalsPrimitivesExplorer />
        </div>
      </section>
    </>
  );
}

interface PackagePanelProps {
  active: PackageId;
  onSelectPackage: (pkg: PackageId) => void;
}

export default function PackagePanel({ active, onSelectPackage }: PackagePanelProps) {
  return (
    <div role="tabpanel" id={`panel-${active}`}>
      {active === 'tracing' && <TracingLanding onSelectPackage={onSelectPackage} />}
      {active === 'evals' && <EvalsSection />}
      {active === 'agents' && <AgentsSection />}
    </div>
  );
}
