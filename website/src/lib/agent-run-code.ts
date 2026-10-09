/**
 * Simplified source of the recorded incident-triage network (see scripts/record-agent-run.mts).
 * Model calls are written as `llm.*`; the recording mocks them with fixed delays.
 */

export type SnippetId =
  | 'events'
  | 'triage'
  | 'investigators'
  | 'findings'
  | 'remediator'
  | 'network';

export const SNIPPETS: { id: SnippetId; file: string; code: string }[] = [
  {
    id: 'events',
    file: 'events.ts',
    code: `const Area = S.Literal('logs', 'metrics', 'deploys')

const UserMessage = AgentNetworkEvent.of('user-message', S.Struct({ text: S.String }))
const Plan = AgentNetworkEvent.of('plan', S.Struct({ steps: S.Array(S.String) }))
const Investigate = AgentNetworkEvent.of('investigate',
  S.Struct({ area: Area, question: S.String }))
const Finding = AgentNetworkEvent.of('finding',
  S.Struct({ area: Area, summary: S.String }))
const FindingsReady = AgentNetworkEvent.of('findings-ready',
  S.Struct({ findings: S.Array(Finding.payload) }))
const ApprovalRequested = AgentNetworkEvent.of('approval-requested',
  S.Struct({ action: S.String, reason: S.String }))
const ApprovalResolved = AgentNetworkEvent.of('approval-resolved',
  S.Struct({ approved: S.Boolean }))
const Chunk = AgentNetworkEvent.of('chunk', S.Struct({ delta: S.String }))
const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }))`,
  },
  {
    id: 'triage',
    file: 'triage.ts',
    code: `export const triage = AgentFactory.run()
  .listensTo([UserMessage])
  .emits([Plan, Investigate])
  .logic(async ({ triggerEvent, emit }) => {
    const plan = await llm.plan(triggerEvent.payload.text)
    emit(Plan.make({ steps: plan.steps }))

    // Fan out: one event per area, picked up in parallel.
    for (const area of ['logs', 'metrics', 'deploys'] as const) {
      emit(Investigate.make({ area, question: plan.questions[area] }))
    }
  })
  .produce({})`,
  },
  {
    id: 'investigators',
    file: 'investigators.ts',
    code: `const investigator = (area: typeof Area.Type, tool: typeof searchLogs) =>
  AgentFactory.run()
    .params(S.Struct({ area: Area }))
    .listensTo([Investigate])
    .emits([Finding, ToolCall])
    .tools(tool)
    .logic(async ({ params, triggerEvent, emit, tools }) => {
      if (triggerEvent.payload.area !== params.area) return

      const [search] = tools.toTools()
      const { summary } = await search.execute(triggerEvent.payload)
      emit(Finding.make({ area: params.area, summary }))
    })
    .produce({ area })

export const logs = investigator('logs', searchLogs)
export const metrics = investigator('metrics', queryMetrics)
export const deploys = investigator('deploys', diffDeploy)`,
  },
  {
    id: 'findings',
    file: 'findings.ts',
    code: `// Fan in: waits for all three findings of the run, then emits once.
export const findings = EventAggregator.listensTo([Finding])
  .emits([FindingsReady])
  .emitWhen(({ runEvents }) => runEvents.filter(Finding.is).length === 3)
  .mapToEmit(({ emit, runEvents }) =>
    emit(
      FindingsReady.make({
        findings: runEvents.filter(Finding.is).map((e) => e.payload),
      }),
    ),
  )`,
  },
  {
    id: 'remediator',
    file: 'remediator.ts',
    code: `const rollbackDeploy = Tool.of({ name: 'rollbackDeploy', description: 'Needs approval' })
  .emits([ApprovalRequested])
  .input(S.Struct({ deploy: S.String }))
  .output(S.Struct({ approved: S.Boolean }))
  .define(async ({ input, emitAndAwait }) => {
    // Streams to the browser, resumes when the matching reply lands on main.
    const reply = await emitAndAwait(
      ApprovalRequested.make({ action: 'Roll back ' + input.deploy, reason }),
      ApprovalResolved.is,
    )
    return { approved: ApprovalResolved.is(reply) && reply.payload.approved }
  })

export const remediator = AgentFactory.run()
  .listensTo([FindingsReady])
  .emits([ApprovalRequested, Chunk, Answer])
  .tools(rollbackDeploy)
  .logic(async ({ triggerEvent, emit, tools }) => {
    const [rollback] = tools.toTools()
    const { approved } = await rollback.execute({ deploy: '4f2a1c' })

    const text = await llm.explain(triggerEvent.payload.findings, { approved })
    for (const delta of chunks(text)) emit(Chunk.make({ delta }))
    emit(Answer.make({ text }))
  })
  .produce({})`,
  },
  {
    id: 'network',
    file: 'network.ts',
    code: `export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator }) => {
    const work = createChannel('work')
    const client = createChannel('client').proxy(proxy.sse())

    registerAgent(triage).subscribe(mainChannel).publishTo(work).publishTo(client)
    for (const agent of [logs, metrics, deploys]) {
      registerAgent(agent).subscribe(work).publishTo(work).publishTo(client)
    }
    registerAggregator(findings).subscribe(work).publishTo(work)
    registerAgent(remediator).subscribe(work).publishTo(client)

    // Catch-all: no listensTo, so it sees every event on all three channels.
    registerAgent(auditLog).subscribe(mainChannel).subscribe(work).subscribe(client)
  },
)`,
  },
];

/** Which snippet defines a node in the event plane. */
export const SNIPPET_FOR: Record<string, SnippetId> = {
  you: 'network',
  main: 'network',
  work: 'network',
  client: 'network',
  auditLog: 'network',
  triage: 'triage',
  logs: 'investigators',
  metrics: 'investigators',
  deploys: 'investigators',
  findings: 'findings',
  remediator: 'remediator',
};
