import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { FsPayloadStoreAdapter, FsStructureStoreAdapter, TraceStore, Tracer } from '@m4trix/tracing';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type Message = { role: 'user' | 'assistant'; content: string };

const traceOutputPath = fileURLToPath(new URL('../../../tmp/tracing-example', import.meta.url));

const AgentState = Annotation.Root({
  messages: Annotation<Message[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  request: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  route: Annotation<'research' | 'fast_path'>({
    reducer: (_left, right) => right,
    default: () => 'research',
  }),
  plan: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  docFindings: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  repositoryFindings: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  scorecard: Annotation<Record<string, number>>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),
  outline: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  draft: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  review: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
});
type AgentStateValue = typeof AgentState.State;

const documentationSearchTool = tool(
  async ({ query, maxResults }) => ({
    query,
    source: 'mock-docs-index',
    results: Array.from({ length: maxResults }, (_, index) => ({
      title: ['Trace viewer quickstart', 'LangGraph callbacks', 'Payload storage'][index] ?? 'Tracing note',
      relevance: Number((0.95 - index * 0.13).toFixed(2)),
      snippet: `Mock documentation hit ${index + 1} for "${query}".`,
    })),
  }),
  {
    name: 'documentation_search',
    description: 'Searches the local documentation corpus for tracing guidance.',
    schema: z.object({
      query: z.string(),
      maxResults: z.number().int().min(1).max(5).default(3),
    }),
  },
);

const repositorySearchTool = tool(
  async ({ symbol, paths }) => ({
    symbol,
    paths,
    matches: paths.map((path, index) => ({
      path,
      symbol,
      line: 24 + index * 17,
      summary: `Mock match for ${symbol} showing how ${path} participates in tracing.`,
    })),
  }),
  {
    name: 'repository_search',
    description: 'Looks up mock repository symbols and file paths.',
    schema: z.object({
      symbol: z.string(),
      paths: z.array(z.string()).min(1),
    }),
  },
);

const qualityScoringTool = tool(
  async ({ draft, dimensions }) =>
    Object.fromEntries(
      dimensions.map((dimension, index) => [
        dimension,
        Math.min(10, Math.max(1, Math.round(draft.length / 60) + 6 - index)),
      ]),
    ),
  {
    name: 'quality_scoring',
    description: 'Scores a draft against requested quality dimensions.',
    schema: z.object({
      draft: z.string(),
      dimensions: z.array(z.enum(['coverage', 'clarity', 'actionability', 'brevity'])).min(1),
    }),
  },
);

function getUserPrompt(state: AgentStateValue): string {
  return state.messages.find((message) => message.role === 'user')?.content ?? '';
}

async function intake(state: AgentStateValue) {
  const request = getUserPrompt(state);
  const route = request.length > 80 ? 'research' : 'fast_path';
  return {
    request,
    route,
    messages: [
      {
        role: 'assistant' as const,
        content: `[Intake] Routed "${request}" to ${route}.`,
      },
    ],
  };
}

async function planWork(state: AgentStateValue) {
  const plan = [
    `Clarify the request: ${state.request}`,
    'Collect tracing docs and repo references.',
    'Draft an explanation with concrete viewer steps.',
    'Score and revise for clarity.',
  ];
  return {
    plan,
    messages: [{ role: 'assistant' as const, content: `[Planner] ${plan.join(' | ')}` }],
  };
}

async function docsResearch(state: AgentStateValue, config?: RunnableConfig) {
  const response = await documentationSearchTool.invoke(
    {
      query: `${state.request} ${state.plan.join(' ')}`,
      maxResults: 3,
    },
    config,
  );
  const docFindings = response.results.map(
    (result) => `${result.title} (${result.relevance}): ${result.snippet}`,
  );
  return {
    docFindings,
    messages: [{ role: 'assistant' as const, content: `[Docs research] ${docFindings.join(' ')}` }],
  };
}

async function repoResearch(state: AgentStateValue, config?: RunnableConfig) {
  const response = await repositorySearchTool.invoke(
    {
      symbol: 'Tracer',
      paths: ['packages/tracing/src/tracer.ts', 'packages/trace-viewer/src/app/App.tsx'],
    },
    config,
  );
  const repositoryFindings = response.matches.map(
    (match) => `${match.path}:${match.line} ${match.summary}`,
  );
  return {
    repositoryFindings,
    messages: [
      { role: 'assistant' as const, content: `[Repo research] ${repositoryFindings.join(' ')}` },
    ],
  };
}

async function synthesizeResearch(state: AgentStateValue) {
  const findings = [...state.docFindings, ...state.repositoryFindings];
  return {
    messages: [
      {
        role: 'assistant' as const,
        content: `[Research synthesis] ${findings.length} findings ready for drafting.`,
      },
    ],
  };
}

async function createOutline(state: AgentStateValue) {
  const outline =
    state.route === 'fast_path'
      ? ['Answer directly', 'Mention how to inspect the generated trace']
      : ['State the tracing goal', 'Summarize docs evidence', 'Map repo behavior', 'Give next steps'];
  return {
    outline,
    messages: [{ role: 'assistant' as const, content: `[Outline] ${outline.join(' -> ')}` }],
  };
}

async function draftAnswer(state: AgentStateValue) {
  const evidence =
    state.docFindings.length > 0 || state.repositoryFindings.length > 0
      ? [...state.docFindings, ...state.repositoryFindings].join('\n')
      : 'No deep research requested; answer from the intake and plan.';
  const draft = [
    `Request: ${state.request}`,
    `Outline: ${state.outline.join(' / ')}`,
    `Evidence:\n${evidence}`,
    'Answer: Use the trace viewer to inspect the root graph, nested research/writing graphs, and tool payloads.',
  ].join('\n\n');
  return {
    draft,
    messages: [{ role: 'assistant' as const, content: `[Draft] ${draft.slice(0, 240)}...` }],
  };
}

async function scoreDraft(state: AgentStateValue, config?: RunnableConfig) {
  const scorecard = await qualityScoringTool.invoke(
    {
      draft: state.draft,
      dimensions: ['coverage', 'clarity', 'actionability', 'brevity'],
    },
    config,
  );
  return {
    scorecard,
    messages: [{ role: 'assistant' as const, content: `[Scorer] ${JSON.stringify(scorecard)}` }],
  };
}

async function finalReview(state: AgentStateValue) {
  const review = `Final review: ${Object.entries(state.scorecard)
    .map(([dimension, score]) => `${dimension}=${score}`)
    .join(', ')}.`;
  return {
    review,
    messages: [{ role: 'assistant' as const, content: `[Review] ${review}` }],
  };
}

const researchGraph = new StateGraph(AgentState)
  .addNode('plan_work', planWork)
  .addNode('docs_research', docsResearch)
  .addNode('repo_research', repoResearch)
  .addNode('synthesize_research', synthesizeResearch)
  .addEdge(START, 'plan_work')
  .addEdge('plan_work', 'docs_research')
  .addEdge('plan_work', 'repo_research')
  .addEdge('docs_research', 'synthesize_research')
  .addEdge('repo_research', 'synthesize_research')
  .addEdge('synthesize_research', END)
  .compile();

const writingGraph = new StateGraph(AgentState)
  .addNode('create_outline', createOutline)
  .addNode('draft_answer', draftAnswer)
  .addNode('score_draft', scoreDraft)
  .addNode('final_review', finalReview)
  .addEdge(START, 'create_outline')
  .addEdge('create_outline', 'draft_answer')
  .addEdge('draft_answer', 'score_draft')
  .addEdge('score_draft', 'final_review')
  .addEdge('final_review', END)
  .compile();

function routeRequest(state: AgentStateValue) {
  return state.route;
}

const graph = new StateGraph(AgentState)
  .addNode('intake', intake)
  .addNode('research_graph', researchGraph)
  .addNode('writing_graph', writingGraph)
  .addEdge(START, 'intake')
  .addConditionalEdges('intake', routeRequest, {
    research: 'research_graph',
    fast_path: 'writing_graph',
  })
  .addEdge('research_graph', 'writing_graph')
  .addEdge('writing_graph', END)
  .compile();

const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: traceOutputPath }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: traceOutputPath }),
});
const tracer = Tracer.from(traceStore);

await graph.invoke(
  {
    messages: [
      {
        role: 'user',
        content:
          'Explain how sunken-trove tracing captures LangGraph subgraphs and tool payloads, then suggest what to inspect first in the viewer.',
      },
    ],
  },
  {
    callbacks: [tracer],
    recursionLimit: 25,
    runName: 'tracing-example-agent',
    metadata: {
      projectId: 'tracing-example',
      env: 'dev',
      scenario: 'tools-and-subgraphs',
    },
  },
);
await tracer.flush();

console.log(`Trace written to ${traceOutputPath}`);
