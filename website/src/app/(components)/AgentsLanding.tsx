'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import Image from 'next/image';
import {
  siEffect,
  siExpress,
  siLangchain,
  siNextdotjs,
  siNodedotjs,
  siTypescript,
} from 'simple-icons';
import type { PackageId } from '@/lib/packages';
import AgentAnatomy from './AgentAnatomy';
import AgentRunReplay from './AgentRunReplay';
import CodeBlock from './CodeBlock';
import CopyCommand from './CopyCommand';
import ResumeGraphic from './graphics/ResumeGraphic';
import SseStreamGraphic from './graphics/SseStreamGraphic';
import {
  ClosingCta,
  Faq,
  type FaqItem,
  Section,
  type Sibling,
  Toolkit,
  WorksWith,
} from './LandingSections';
import ToolFormats from './ToolFormats';
import WiringExplorer from './WiringExplorer';

const DOCS_HREF = '/docs';

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
        <div className="max-w-4xl">
          <p className="eyebrow rise-in">Event-driven agents for TypeScript</p>
          <h1
            className="rise-in font-display text-[clamp(2.4rem,5.6vw,4rem)] leading-[1.04] font-bold tracking-[-0.035em] text-text-1"
            style={{ '--rise-delay': '60ms' } as React.CSSProperties}
          >
            Multi-agent systems,{' '}
            <span className="text-(--accent) sm:block">wired by typed events.</span>
          </h1>
          <p
            className="rise-in mt-6 max-w-[54ch] text-[17px] leading-relaxed text-text-2 sm:text-lg"
            style={{ '--rise-delay': '120ms' } as React.CSSProperties}
          >
            Agents are async handlers that listen and emit. Channels route events between them and
            stream them to your client.
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
            <CopyCommand command="pnpm add @m4trix/core" />
          </div>
        </div>

        <div
          className="rise-in mt-12 sm:mt-14"
          style={{ '--rise-delay': '260ms' } as React.CSSProperties}
        >
          <AgentRunReplay />
          <p className="mt-4 text-center text-[13px] text-text-3">
            A recorded run of @m4trix/core with mocked model calls, replayed slower than real time.
            Approve or deny to pick the branch.
          </p>
        </div>
      </div>
    </section>
  );
}

const STACK = [siTypescript, siEffect, siNodedotjs, siNextdotjs, siExpress, siLangchain];

/* ─── What changes ────────────────────────────────────────────────────── */

const SHIFTS = [
  {
    pain: 'Adding a step means editing the graph, its state type and every edge around it.',
    fix: 'Register one more agent on a channel. The others never find out.',
    code: 'registerAgent(reviewer).subscribe(client)',
  },
  {
    pain: 'One shared state object that every node can read and overwrite.',
    fix: 'Each agent sees only the events it listens to, typed by their schema.',
    code: '.listensTo([Message])',
  },
  {
    pain: 'Streaming partial output to the UI is a second pipeline you build by hand.',
    fix: "Put an SSE proxy on a channel. The run's events on it stream to the browser.",
    code: "createChannel('client').proxy(proxy.sse())",
  },
  {
    pain: 'Waiting on a sub-agent or a human approval turns into polling and callbacks.',
    fix: 'emitAndAwait publishes a request and resumes on the matching reply.',
    code: 'await emitAndAwait(Ask.make(q), Answer.is)',
  },
];

function Shifts() {
  return (
    <Section>
      <h2 className="lp-h2 max-w-2xl">What changes when agents talk in events</h2>
      <div className="mt-12 grid gap-x-12 sm:grid-cols-2">
        {SHIFTS.map((shift) => (
          <div
            key={shift.code}
            className="flex min-w-0 flex-col border-t border-(--border) pt-6 pb-10"
          >
            <p className="text-[15px] leading-relaxed text-text-3">{shift.pain}</p>
            <div className="mt-4 border-l-2 border-(--accent) pl-4">
              <p className="font-display text-lg leading-snug font-semibold text-text-1">
                {shift.fix}
              </p>
              <code className="mt-3 block truncate font-mono text-[12.5px] text-(--accent-text)">
                {shift.code}
              </code>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ─── Anatomy ─────────────────────────────────────────────────────────── */

function Anatomy() {
  return (
    <Section>
      <h2 className="lp-h2">An agent is a typed handler</h2>
      <p className="lp-lead mb-12">
        Declare what it hears and what it may say. The logic is a plain async function, so any model
        SDK works inside it.
      </p>
      <AgentAnatomy />
      <div className="mt-16 border-t border-(--border) pt-12">
        <ToolFormats />
      </div>
    </Section>
  );
}

/* ─── Wiring ──────────────────────────────────────────────────────────── */

function Wiring() {
  return (
    <Section className="section-band">
      <h2 className="lp-h2">Add an agent. Leave the others alone.</h2>
      <p className="lp-lead mb-10">
        Agents never import each other. A new one subscribes to a channel and starts receiving
        events, so the change is one line in the network.
      </p>
      <WiringExplorer />
    </Section>
  );
}

/* ─── Production pieces ───────────────────────────────────────────────── */

const AWAIT_CODE = `const reply = await emitAndAwait(
  ApprovalRequested.make({ action, reason }),
  ApprovalResolved.is,
  { timeout: '30 seconds' },
)`;

const LAYERS_CODE = `const network = AgentNetwork
  .dependsOn([Database])
  .setup(wire)

network.run({ layers: {} })`;

const TEST_CODE = `const emitted = []
await assistant.invoke({
  triggerEvent: Message.makeBound(
    { runId: 'r1', contextId: 'c1' },
    { role: 'user', text: 'hi' },
  ),
  emit: (event) => emitted.push(event),
})`;

function Production() {
  return (
    <Section>
      <h2 className="lp-h2 max-w-2xl">Built for the parts after the demo</h2>
      <p className="lp-lead">
        Approvals, dependencies, tests and traces. None of them add a new concept.
      </p>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        <div className="bento-cell bento-cell-accent lg:col-span-2">
          <h3 className="bento-title">Wait for a reply, from an agent or a person</h3>
          <p className="bento-body max-w-[56ch]">
            The remediator in the run above asks before rolling back. The request streams to the
            browser, and the tool resumes when the matching event comes back.
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <CodeBlock
              className="agent-code-block min-w-0"
              code={AWAIT_CODE}
              language="typescript"
              filename="rollback-deploy.tool.ts"
            />
            <div className="mono-panel grid min-w-0 gap-x-6 sm:grid-cols-[auto_1fr]">
              <span className="text-text-3">client</span>
              <span className="truncate text-(--accent)">approval-requested</span>
              <span className="text-text-3">browser</span>
              <span className="truncate text-text-1">
                Roll back deploy 4f2a1c? <span className="text-success">Approve</span>
              </span>
              <span className="text-text-3">main</span>
              <span className="truncate text-(--accent)">approval-resolved</span>
            </div>
          </div>
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">Dependencies the compiler checks</h3>
          <p className="bento-body mb-6">
            The network declares the layers its agents and tools need. Run it without one and it
            does not compile.
          </p>
          <CodeBlock
            className="agent-code-block mt-auto min-w-0"
            code={LAYERS_CODE}
            language="typescript"
            filename="server.ts"
          />
          <p className="mono-panel mt-3 text-[12px] leading-relaxed">
            <span className="text-text-3">$ tsc --noEmit</span>
            <br />
            <span className="text-(--red)">error TS2741:</span>{' '}
            <span className="text-text-1">
              Property &apos;Database&apos; is missing in type &apos;{'{}'}&apos;
            </span>
          </p>
        </div>

        <div className="bento-cell">
          <h3 className="bento-title">Test an agent by calling it</h3>
          <p className="bento-body mb-6">
            No network, no server. Build the trigger event, collect what it emits, assert.
          </p>
          <CodeBlock
            className="agent-code-block mt-auto min-w-0"
            code={TEST_CODE}
            language="typescript"
            filename="assistant.spec.ts"
          />
          <p className="mt-3 font-mono text-[12px] text-success">✓ replies to a user message</p>
        </div>

        <div className="bento-cell lg:col-span-2">
          <h3 className="bento-title">Every run in the trace viewer</h3>
          <p className="bento-body max-w-[60ch]">
            Hand the network a tracer from @m4trix/tracing. Agent calls, published events and LLM
            spans land in the same viewer your LangGraph traces use.
          </p>
          <code className="mono-panel mt-5 block truncate text-(--cyan)">
            {'AgentNetwork.setup(wire, { networkTracer: toM4trixTracer(tracer) })'}
          </code>
          <div className="mt-5 overflow-hidden rounded-lg border border-(--border-md)">
            <Image
              src="/screens/trace-viewer-run.webp"
              alt="The m4trix trace viewer showing a run tree with a selected call, its metadata, input and output payloads."
              width={2880}
              height={1800}
              sizes="(min-width: 1024px) 720px, 100vw"
              className="block h-56 w-full object-cover object-top-left"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ─── Ship ────────────────────────────────────────────────────────────── */

const ROUTE_CODE = `import { NextEndpoint, registerSSEStream } from '@m4trix/core'

const api = network.expose(
  registerSSEStream({ channel: 'client', triggerEvents: [UserMessage] }),
)

const handler = NextEndpoint.from(api, {
  requestToContextId: (req) =>
    req.headers.get('x-chat-id') ?? crypto.randomUUID(),
}).handler()

export const POST = handler
export const GET = handler // EventSource: ?payload=<JSON>`;

function Ship() {
  return (
    <Section>
      <h2 className="lp-h2">Stream it from one route</h2>
      <p className="lp-lead mb-12">
        Expose the client channel and mount the handler. A body that fails the event schema gets a
        400 before any run starts. The response streams that run&apos;s events from the channel and
        closes when the run ends. Express works the same way.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <CodeBlock
          className="agent-code-block min-w-0"
          code={ROUTE_CODE}
          language="typescript"
          filename="app/api/chat/route.ts"
        />
        <SseStreamGraphic />
      </div>
    </Section>
  );
}

/* ─── Run controls ────────────────────────────────────────────────────── */

type Control = {
  api: string;
  title: string;
  body: string;
  code?: { file: string; source: string };
  visual?: React.ReactNode;
};

const CONTROLS: Control[] = [
  {
    api: 'endsOn',
    title: 'A run ends on an event you name',
    body: 'Once the answer is out the run completes and its stream closes. A run that stalls fails after 60 idle seconds instead of hanging.',
    code: {
      file: 'network.ts',
      source: `endsOn(Answer) // in AgentNetwork.setup

// or from an agent: complete(), fail(error)`,
    },
  },
  {
    api: 'maxDepth · maxEvents · maxCostUsd',
    title: 'Loops and spend have a ceiling',
    body: 'A run fails 25 hops deep or past 1000 events. Report what each model call used and it also stops at your budget.',
    code: {
      file: 'network.ts',
      source: `AgentNetwork.setup(wire, { maxCostUsd: 0.5 })

// in agent logic, after each model call
reportUsage({ model, inputTokens, outputTokens, costUsd })
// over budget: m4trix:run.failed, error.limit === 'cost'`,
    },
  },
  {
    api: 'signal',
    title: 'A closed tab stops the model call',
    body: "If the client leaves and does not reconnect within 30 seconds, the run is cancelled and every agent's signal aborts.",
    code: {
      file: 'assistant.ts',
      source: `.logic(async ({ signal }) => {
  const reply = await openai.chat.completions.create(request, { signal })
})`,
    },
  },
  {
    api: 'principal',
    title: 'Each user reads only their own history',
    body: 'auth returns a principal. Its id namespaces the store, so two users who send the same chat id get two conversations.',
    code: {
      file: 'app/api/chat/route.ts',
      source: `auth: async ({ request }) => {
  const user = await getUser(request)
  return user
    ? { allowed: true, principal: { id: user.id } }
    : { allowed: false, status: 401 }
},`,
    },
  },
  {
    api: 'Last-Event-ID',
    title: 'A dropped stream picks up where it left off',
    body: 'Durable events carry an SSE id. EventSource reconnects with the last one, and the route replays what was missed, then follows the run live.',
    visual: <ResumeGraphic />,
  },
  {
    api: 'executeForModel',
    title: 'Tool errors go back to the model',
    body: 'Bad arguments, a thrown error or a timeout come back as a typed result with the failing fields, so the model can fix the call.',
    code: {
      file: 'assistant.ts',
      source: `const result = await tool.executeForModel(args, { toolCallId })
// { ok: false, error: { kind: 'invalid_input', message, issues } }

messages.push({
  role: 'tool',
  tool_call_id: toolCallId,
  content: JSON.stringify(result),
})`,
    },
  },
];

function RunControls() {
  return (
    <Section>
      <h2 className="lp-h2 max-w-2xl">Every run ends, inside its limits</h2>
      <p className="lp-lead">
        The runtime ends runs, bounds them, cancels them when nobody listens and keeps each user to
        their own history. Your agents stay plain async functions.
      </p>
      <div className="mt-12 grid gap-x-12 lg:grid-cols-2">
        {CONTROLS.map((control) => (
          <div
            key={control.api}
            className="flex min-w-0 flex-col border-t border-(--border) pt-6 pb-10"
          >
            <code className="block truncate font-mono text-[12.5px] text-(--accent-text)">
              {control.api}
            </code>
            <h3 className="mt-2 font-display text-lg leading-snug font-semibold text-text-1">
              {control.title}
            </h3>
            <p className="mt-2 max-w-[56ch] text-[15px] leading-relaxed text-text-2">
              {control.body}
            </p>
            <div className="mt-5 min-w-0">
              {control.code ? (
                <CodeBlock
                  className="agent-code-block min-w-0"
                  code={control.code.source}
                  language="typescript"
                  filename={control.code.file}
                />
              ) : (
                control.visual
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ─── FAQ ─────────────────────────────────────────────────────────────── */

const FAQ: FaqItem[] = [
  {
    q: 'Is it ready for production?',
    a: 'Not yet. The package is pre-alpha and the API still changes between minor versions. History goes through a pluggable store, in memory by default, but a run lives on the instance that started it. Several instances need a shared store and sticky routing until distributed transports land after 1.0.',
  },
  {
    q: 'How is this different from LangGraph?',
    a: 'LangGraph compiles a graph of nodes and edges that share one state object. Here agents declare the events they listen to and emit, and the topology comes from channel subscriptions. You can still run a LangGraph or LangChain agent inside a handler.',
  },
  {
    q: 'Do I need to know Effect?',
    a: 'A little. Event payloads are Effect Schemas, re-exported as S. Agent logic is a plain async function, and the Next.js and Express adapters run the Effect runtime for you.',
  },
  {
    q: 'Which model providers does it support?',
    a: 'Any. The core never calls a model itself. Your handler does, with LangChain, a provider SDK or plain fetch.',
  },
  {
    q: 'How do I see what happened in a run?',
    a: 'Pass consoleTracing: true to log every event and agent call, or give the network toM4trixTracer from @m4trix/tracing and open the run in the trace viewer.',
  },
  {
    q: 'What does it cost?',
    a: 'Nothing. It is MIT licensed with no seats or usage tiers.',
  },
];

const SIBLINGS: Sibling[] = [
  {
    id: 'tracing',
    name: '@m4trix/tracing',
    title: 'Trace every run',
    body: 'LangGraph and LangChain traces in your own files or AWS account, with a local viewer.',
  },
  {
    id: 'evals',
    name: '@m4trix/evals',
    title: 'Score every change',
    body: 'Datasets, evaluators and run configs as TypeScript files, run from the CLI like Vitest.',
  },
];

export default function AgentsLanding({
  onSelectPackage,
}: {
  onSelectPackage: (pkg: PackageId) => void;
}) {
  return (
    <>
      <Hero />
      <WorksWith label="Built on Effect, runs in your Node app" icons={STACK} />
      <Shifts />
      <Anatomy />
      <Wiring />
      <Production />
      <Ship />
      <RunControls />
      <Faq items={FAQ} />
      <Toolkit siblings={SIBLINGS} onSelectPackage={onSelectPackage} />
      <ClosingCta
        title="Wire your first agent"
        body="One event, one handler, one route."
        href={DOCS_HREF}
      />
    </>
  );
}
