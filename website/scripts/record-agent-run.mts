/**
 * Runs a mocked incident-triage network on @m4trix/core and records every published event and
 * agent invocation. The landing page replays the recording, so the UI shows a real run of the
 * library rather than a hand-written animation.
 *
 *   pnpm --filter website record:agents
 *
 * The model calls are mocked with fixed delays. Everything else (channels, fan-out, the
 * aggregator, emitAndAwait, tools) is the real runtime.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Core's own copy of effect, so the script and the runtime share one instance without adding
// effect to the website's dependencies.
import { Effect, Queue } from '../../packages/core/node_modules/effect/dist/esm/index.js';
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  ChannelName,
  EventAggregator,
  type NetworkTracer,
  noopRunTraceScope,
  type RunTraceScope,
  S,
  Tool,
} from '../../packages/core/src/matrix/index.js';

/* ─── Events ─────────────────────────────────────────────────────────── */

const Area = S.Literal('logs', 'metrics', 'deploys');
type Area = typeof Area.Type;

const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }));
const Plan = AgentNetworkEvent.of('plan', S.Struct({ steps: S.Array(S.String) }));
const Investigate = AgentNetworkEvent.of(
  'investigate',
  S.Struct({ area: Area, question: S.String }),
);
const ToolCall = AgentNetworkEvent.of(
  'tool-call',
  S.Struct({
    area: Area,
    tool: S.String,
    phase: S.Literal('start', 'end'),
    summary: S.optional(S.String),
  }),
);
const Finding = AgentNetworkEvent.of('finding', S.Struct({ area: Area, summary: S.String }));
const FindingsReady = AgentNetworkEvent.of(
  'findings-ready',
  S.Struct({ findings: S.Array(S.Struct({ area: Area, summary: S.String })) }),
);
const ApprovalRequested = AgentNetworkEvent.of(
  'approval-requested',
  S.Struct({ action: S.String, reason: S.String }),
);
const ApprovalResolved = AgentNetworkEvent.of(
  'approval-resolved',
  S.Struct({ approved: S.Boolean }),
);
const Chunk = AgentNetworkEvent.of('chunk', S.Struct({ delta: S.String }));
const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));

/* ─── Attribution ────────────────────────────────────────────────────── */

// The tracer sees payloads, not emitters. Payload objects pass through emit by reference,
// so tagging them here tells the recording which lane published each event.
const emitter = new WeakMap<object, string>();
function by<E extends { payload: unknown }>(lane: string, event: E): E {
  emitter.set(event.payload as object, lane);
  return event;
}

const think = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Mocked model call. The span goes through the agent's tracing scope, the same hook a real
// LangChain or SDK call would use, so the recording knows when each agent was thinking.
async function llm(tracing: RunTraceScope, name: string, ms: number) {
  const span = tracing.startRun('llm', name);
  await think(ms);
  await span.end();
}

/* ─── Scenario ───────────────────────────────────────────────────────── */

const PROMPT = 'Checkout p95 jumped after the 14:02 deploy. What happened?';

const INVESTIGATIONS: Record<
  Area,
  { question: string; tool: string; ms: number; queryMs: number; summary: string }
> = {
  logs: {
    question: 'Errors on the checkout path since 14:02?',
    tool: 'searchLogs',
    ms: 700,
    queryMs: 500,
    summary: '312 timeouts from the card API client since 14:03',
  },
  metrics: {
    question: 'How did checkout latency change?',
    tool: 'queryMetrics',
    ms: 900,
    queryMs: 650,
    summary: 'Checkout p95 went from 180 ms to 2.4 s at 14:03',
  },
  deploys: {
    question: 'What changed in the 14:02 deploy?',
    tool: 'diffDeploy',
    ms: 1300,
    queryMs: 550,
    summary: 'Deploy 4f2a1c wraps the card API client in a retry loop',
  },
};

const AREAS = Object.keys(INVESTIGATIONS) as Area[];

const ANSWERS = {
  approved:
    'Rolled back 4f2a1c. The new retry loop tripled calls to the card API, so requests queued behind timeouts. p95 should drop back to about 180 ms within a few minutes.',
  denied:
    'Rollback skipped. The retry loop in 4f2a1c triples calls to the card API, so p95 stays near 2.4 s until the loop is capped or the deploy is reverted.',
};

function searchTool(area: Area) {
  const { tool, ms, summary } = INVESTIGATIONS[area];
  return Tool.of({ name: tool, description: `Mocked ${area} lookup` })
    .emits([ToolCall])
    .input(S.Struct({ question: S.String }))
    .output(S.Struct({ summary: S.String }))
    .define(async ({ emit }) => {
      emit(by(area, ToolCall.make({ area, tool, phase: 'start' })));
      await think(ms);
      emit(by(area, ToolCall.make({ area, tool, phase: 'end', summary })));
      return { summary };
    });
}

function investigator(area: Area) {
  return AgentFactory.run()
    .params(S.Struct({ area: Area }))
    .listensTo([Investigate])
    .emits([Finding, ToolCall])
    .tools(searchTool(area))
    .logic(async ({ params, triggerEvent, emit, tools, tracing }) => {
      if (triggerEvent.payload.area !== params.area) return;
      await llm(tracing, 'write-query', INVESTIGATIONS[params.area].queryMs);
      const [search] = tools.toTools();
      const { summary } = (await search.execute({
        question: triggerEvent.payload.question,
      })) as { summary: string };
      await llm(tracing, 'summarize', 600);
      emit(by(params.area, Finding.make({ area: params.area, summary })));
    })
    .produce({ area });
}

const triage = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Plan, Investigate])
  .logic(async ({ emit, tracing }) => {
    await llm(tracing, 'plan-investigation', 1200);
    emit(
      by(
        'triage',
        Plan.make({
          steps: [
            'Search checkout errors since 14:02',
            'Compare p95 before and after the deploy',
            'Diff deploy 4f2a1c',
          ],
        }),
      ),
    );
    await think(160);
    for (const area of AREAS) {
      emit(by('triage', Investigate.make({ area, question: INVESTIGATIONS[area].question })));
    }
  })
  .produce({});

const findings = EventAggregator.listensTo([Finding])
  .emits([FindingsReady])
  .emitWhen(({ runEvents }) => runEvents.filter(Finding.is).length === AREAS.length)
  .mapToEmit(({ emit, runEvents }) => {
    const all = runEvents.filter(Finding.is).map((event) => event.payload);
    emit(by('findings', FindingsReady.make({ findings: all })));
  });

const rollbackDeploy = Tool.of({
  name: 'rollbackDeploy',
  description: 'Roll back a deploy after a human approves it',
})
  .emits([ApprovalRequested])
  .input(S.Struct({ deploy: S.String }))
  .output(S.Struct({ approved: S.Boolean }))
  .define(async ({ input, emitAndAwait }) => {
    const reply = await emitAndAwait(
      by(
        'remediator',
        ApprovalRequested.make({
          action: `Roll back deploy ${input.deploy}`,
          reason: 'Its retry loop matches the timeouts and the p95 jump.',
        }),
      ),
      ApprovalResolved.is,
      { timeout: '30 seconds' },
    );
    const approved = ApprovalResolved.is(reply) && reply.payload.approved;
    if (approved) await think(650);
    return { approved };
  });

const remediator = AgentFactory.run()
  .listensTo([FindingsReady])
  .emits([ApprovalRequested, Chunk, Answer])
  .tools(rollbackDeploy)
  .logic(async ({ emit, tools, tracing }) => {
    await llm(tracing, 'choose-action', 1000);
    const [rollback] = tools.toTools();
    const { approved } = (await rollback.execute({ deploy: '4f2a1c' })) as {
      approved: boolean;
    };
    const text = approved ? ANSWERS.approved : ANSWERS.denied;
    // Time to first token, then the stream.
    const span = tracing.startRun('llm', 'explain');
    await think(500);
    const words = text.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      await think(90);
      const delta = `${i === 0 ? '' : ' '}${words.slice(i, i + 3).join(' ')}`;
      emit(by('remediator', Chunk.make({ delta })));
    }
    await span.end();
    emit(by('remediator', Answer.make({ text })));
  })
  .produce({});

// Catch-all: no listensTo, so it receives every event on the channels it subscribes to.
const auditLog = AgentFactory.run()
  .logic(async () => {})
  .produce({});

/* ─── Recording ──────────────────────────────────────────────────────── */

type RecordedEvent = {
  i: number;
  t: number;
  name: string;
  channels: string[];
  by: string;
  payload: unknown;
};

type RecordedSpan = { lane: string; name: string; start: number; end: number };

type RecordedInvocation = {
  lane: string;
  channel: string;
  trigger: number;
  start: number;
  end: number;
};

async function record(approved: boolean) {
  const lanes = new Map<string, string>();
  const events: RecordedEvent[] = [];
  const byPayload = new Map<unknown, RecordedEvent>();
  const open = new Map<RunTraceScope, RecordedInvocation>();
  const invocations: RecordedInvocation[] = [];
  const spans: RecordedSpan[] = [];
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);

  const tracer: NetworkTracer = {
    onRunStart: async () => {},
    onRunEnd: async () => {},
    onEventPublish: async ({ channel, name, payload }) => {
      const existing = byPayload.get(payload);
      if (existing) {
        existing.channels.push(channel);
        return;
      }
      const event: RecordedEvent = {
        i: events.length,
        t: now(),
        name,
        channels: [channel],
        by: emitter.get(payload as object) ?? 'unknown',
        payload,
      };
      events.push(event);
      byPayload.set(payload, event);
    },
    onAgentInvokeStart: async ({ agentId, channel, trigger }) => {
      const lane = lanes.get(agentId) ?? agentId;
      const scope: RunTraceScope = {
        ...noopRunTraceScope(trigger.meta),
        startRun: (_type, name) => {
          const span: RecordedSpan = { lane, name, start: now(), end: now() };
          return {
            runId: `${lane}-${name}-${span.start}`,
            end: async () => {
              span.end = now();
              spans.push(span);
            },
          };
        },
      };
      open.set(scope, {
        lane,
        channel: channel ?? '',
        trigger: byPayload.get(trigger.payload)?.i ?? -1,
        start: now(),
        end: now(),
      });
      return scope;
    },
    onAgentInvokeEnd: async (scope) => {
      const invocation = open.get(scope);
      if (!invocation) return;
      invocation.end = now();
      invocations.push(invocation);
    },
    flush: async () => {},
  };

  const agents = { triage, remediator, auditLog };
  const investigators = AREAS.map((area) => [area, investigator(area)] as const);
  for (const [lane, agent] of Object.entries(agents)) lanes.set(agent.getId(), lane);
  for (const [lane, agent] of investigators) lanes.set(agent.getId(), lane);
  lanes.set(findings.getId(), 'findings');

  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator }) => {
      const work = createChannel('work');
      const client = createChannel('client').proxy(proxy.sse());

      registerAgent(triage).subscribe(mainChannel).publishTo(work).publishTo(client);
      for (const [, agent] of investigators) {
        registerAgent(agent).subscribe(work).publishTo(work).publishTo(client);
      }
      registerAggregator(findings).subscribe(work).publishTo(work);
      registerAgent(remediator).subscribe(work).publishTo(client);
      registerAgent(auditLog).subscribe(mainChannel).subscribe(work).subscribe(client);
    },
    { networkTracer: tracer },
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plane = yield* network.run();
        const fromClient = yield* plane.subscribe(ChannelName('client'));
        // Let the forked subscriber loops attach before the first publish.
        yield* Effect.sleep('30 millis');

        const meta = { runId: 'run-1', contextId: 'incident-chat' };
        yield* plane.publish(ChannelName('main'), {
          ...by('you', UserMessage.make({ text: PROMPT })),
          meta,
        });

        while (true) {
          const envelope = yield* Queue.take(fromClient);
          if (envelope.name === 'approval-requested') {
            // The person reading the approval card in the browser.
            yield* Effect.sleep('900 millis');
            yield* plane.publish(ChannelName('main'), {
              ...by('you', ApprovalResolved.make({ approved })),
              meta: envelope.meta,
            });
          }
          if (envelope.name === 'answer') break;
        }
        yield* Effect.sleep('80 millis');
      }),
    ),
  );

  return {
    duration: Math.max(...events.map((e) => e.t), ...invocations.map((inv) => inv.end)),
    events,
    spans: spans.sort((a, b) => a.start - b.start),
    // Investigators also wake for the other two areas and return at once; those carry no work.
    invocations: invocations
      .filter(
        (inv) => inv.end - inv.start >= 5 || inv.lane === 'auditLog' || inv.lane === 'findings',
      )
      .sort((a, b) => a.start - b.start),
  };
}

const approved = await record(true);
const denied = await record(false);

// The UI swaps branches at the approval request, so both runs must agree up to that point.
const cut = (run: typeof approved) =>
  run.events.slice(0, run.events.findIndex((e) => e.name === 'approval-requested') + 1);
const prefix = (run: typeof approved) =>
  cut(run)
    .map((e) => `${e.by}:${e.name}`)
    .join(',');
if (prefix(approved) !== prefix(denied)) {
  throw new Error('Branches diverge before the approval request; rerun the recording.');
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/agent-run.json');
writeFileSync(
  out,
  `${JSON.stringify({ prompt: PROMPT, branches: { approved, denied } }, null, 2)}\n`,
);
console.log(
  `Recorded ${approved.events.length} events (approved, ${approved.duration} ms) and ${denied.events.length} (denied, ${denied.duration} ms) to ${out}`,
);
