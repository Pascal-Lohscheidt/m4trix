import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { FsPayloadStoreAdapter, FsStructureStoreAdapter, TraceStore, Tracer } from '@m4trix/tracing';
import { fileURLToPath } from 'node:url';

type Message = { role: 'user' | 'assistant'; content: string };

const traceOutputPath = fileURLToPath(new URL('../../../tmp/tracing-example', import.meta.url));

const AgentState = Annotation.Root({
  messages: Annotation<Message[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  /** Mock scratchpad for a longer trace tree (more nested chain callbacks). */
  plan: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  researchNotes: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  toolResult: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  draft: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
});

const graph = new StateGraph(AgentState)
  .addNode('planner', async (state) => {
    const user = state.messages.at(-1)?.content ?? '';
    const plan = `Goals: answer "${user}"; steps: research → lookup → summarize → review.`;
    return {
      plan,
      messages: [{ role: 'assistant' as const, content: `[Planner] ${plan}` }],
    };
  })
  .addNode('researcher', async (state) => {
    const notes = `Notes on: ${state.plan.slice(0, 80)}… (mock web + docs scan)`;
    return {
      researchNotes: notes,
      messages: [{ role: 'assistant' as const, content: `[Researcher] ${notes}` }],
    };
  })
  .addNode('tool_lookup', async (state) => {
    const result = `lookup("${state.researchNotes.slice(0, 40)}") → mock facts blob`;
    return {
      toolResult: result,
      messages: [{ role: 'assistant' as const, content: `[Tool] ${result}` }],
    };
  })
  .addNode('summarizer', async (state) => {
    const draft = `Draft: combine plan + notes + tool:\n${state.plan}\n${state.researchNotes}\n${state.toolResult}`;
    return {
      draft,
      messages: [{ role: 'assistant' as const, content: `[Summarizer] ${draft.slice(0, 200)}…` }],
    };
  })
  .addNode('reviewer', async (state) => {
    const review = `Review OK: length=${state.draft.length}; tone=neutral (mock).`;
    return {
      messages: [{ role: 'assistant' as const, content: `[Reviewer] ${review}` }],
    };
  })
  .addEdge(START, 'planner')
  .addEdge('planner', 'researcher')
  .addEdge('researcher', 'tool_lookup')
  .addEdge('tool_lookup', 'summarizer')
  .addEdge('summarizer', 'reviewer')
  .addEdge('reviewer', END)
  .compile();

const traceStore = TraceStore.of({
  structureStoreAdapter: new FsStructureStoreAdapter({ path: traceOutputPath }),
  payloadStoreAdapter: new FsPayloadStoreAdapter({ path: traceOutputPath }),
});
const tracer = Tracer.from(traceStore);

await graph.invoke(
  { messages: [{ role: 'user', content: 'Explain sunken-trove tracing in one paragraph.' }] },
  {
    callbacks: [tracer],
    metadata: {
      projectId: 'tracing-example',
      env: 'dev',
    },
  },
);
await tracer.flush();

console.log(`Trace written to ${traceOutputPath}`);
