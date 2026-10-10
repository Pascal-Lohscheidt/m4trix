---
title: "How to ..."
description: "Task-focused answers with snippet-first examples for common agent workflows."
---

Short answers to specific questions. Each section shows the minimum code to wire pieces together — partial snippets across files, not full apps. Sixteen topics below; use the table of contents to jump.

---

## How to communicate between frontend and agent

The browser POSTs to an exposed route; the network publishes a start event on the main channel; agents emit to a client channel with `proxy.sse()`; the response streams back as SSE.

### Define events

```ts
// network/events.ts
import { AgentNetworkEvent, S } from '@m4trix/core/matrix';

export const MessageEvent = AgentNetworkEvent.of(
  'message',
  S.Struct({ message: S.String, role: S.String }),
);
```

### Wire the network and expose SSE

```ts
// network/network.ts
const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(exampleAgent).subscribe(mainChannel).publishTo(client);
    // The user's message starts the run; the assistant's reply ends it.
    endsOn(MessageEvent, (event) => event.payload.role === 'assistant');
  },
);
```

```ts
// app/api/chat/route.ts
import { NextEndpoint, registerSSEStream } from '@m4trix/core/matrix';

const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [MessageEvent],
    onRequest: ({ emitStartEvent, req, payload }) =>
      emitStartEvent({
        contextId: req.contextId ?? crypto.randomUUID(),
        runId: req.runId ?? crypto.randomUUID(),
        event: MessageEvent.make({
          message: (payload as { request?: string }).request ?? '',
          role: 'user',
        }),
      }),
  }),
);

export const POST = NextEndpoint.from(api, {
  requestToContextId: (req) => req.headers.get('x-correlation-id') ?? crypto.randomUUID(),
}).handler();
```

### Read the stream in React

```ts
// app/_hooks/use-sse-agent-chat.ts
const response = await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-correlation-id': crypto.randomUUID(),
  },
  body: JSON.stringify({ request: text }),
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));
    if (event.name === 'm4trix:run.failed') showError(event.payload.error.message);
    if (event.name === 'message-stream-chunk') {
      appendChunk(event.payload.chunk);
      if (event.payload.isFinal) finish();
    }
  }
}
```

See [Streaming](../guides/streaming.md) and [IO + Adapters](../api-reference/io-adapters.md).

---

## How to stream LLM tokens to the client

Emit one event per token (or chunk) with `isFinal: false`, then a terminal chunk with `isFinal: true`. The client channel SSE proxy forwards each emit to the browser.

### Define a stream chunk event

```ts
// network/events.ts
export const MessageStreamChunkEvent = AgentNetworkEvent.of(
  'message-stream-chunk',
  S.Struct({ chunk: S.String, isFinal: S.Boolean, role: S.String }),
);
```

### Emit chunks from agent logic

```ts
// network/example-agent.ts
.logic(async ({ triggerEvent, emit, history }) => {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [/* ...from (await history.context({ limit: 50 })).events... */],
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) {
      emit(
        MessageStreamChunkEvent.make({
          chunk: text,
          isFinal: false,
          role: 'assistant',
        }),
      );
    }
  }

  emit(
    MessageStreamChunkEvent.make({
      chunk: '',
      isFinal: true,
      role: 'assistant',
    }),
  );
})
```

Register the agent on a channel with `proxy.sse()` so chunks reach the HTTP client. See `examples/core-example/app/sse/api/example-agent.ts`.

---

## How to add tools to an agent

Define tools with `Tool.of()`, attach them via `.tools([...])` on the agent factory, and call them inside `.logic()` through `tools.toTools()` or the bound collection.

### Define a tool

```ts
// network/tools/web-search.tool.ts
import { S, Tool } from '@m4trix/core';

export const webSearchTool = Tool.of({
  name: 'webSearch',
  description: 'Search the web for up-to-date information.',
})
  .emits([ToolUsedEvent])
  .input(S.Struct({ query: S.String }))
  .output(S.Struct({ results: S.Array(/* ... */) }))
  .dependsOn(WithTavelyWebsearchLayer)
  .define(async ({ input, layers, emit, toolCallId }) => {
    emit(ToolUsedEvent.make({ toolCallId, toolName: 'webSearch', phase: 'start', input }));
    const results = await layers.WithTavelyWebsearchLayer.search(input.query);
    emit(ToolUsedEvent.make({ toolCallId, toolName: 'webSearch', phase: 'end', output: { results } }));
    return { results };
  });
```

### Attach tools to the agent

```ts
// network/assistant-agent.ts
export const assistantAgent = AgentFactory.run()
  .listensTo([MessageEvent])
  .emits([MessageStreamChunkEvent, ToolUsedEvent])
  .tools([...mainAssistantTools])
  .logic(async ({ tools, layers, emit, tracing }) => {
    const reactAgent = createAssistantReactAgent(tools.toTools(), { memoryContext });
    // ... run agent, stream tokens via emit ...
  })
  .produce({});
```

Tools can emit events (for UI side-effects) and depend on [dependency layers](../concepts/package-structure.md) for shared services. See `examples/assistant-app/src/network/tools/`.

Tool names must match `^[a-zA-Z0-9_-]{1,64}$` (accepted by every provider); `Tool.of()` throws a `ToolDefinitionError` otherwise. The input schema must be an object schema (`S.Struct`) that converts to JSON Schema: `define()` throws a `ToolDefinitionError` for schemas such as `S.DateFromSelf` or `S.instanceOf(...)`, so the problem shows up at startup rather than on the first model call. Transformations are described by their encoded side (`S.NumberFromString` becomes `{ type: 'string' }`), which is what the model sends.

### Send tools to a model provider

The collection turns the agent's tools into each provider's format. m4trix does not depend on any provider SDK; the shapes are plain objects.

| Method | Shape | Targets |
| --- | --- | --- |
| `tools.toJsonSchemas()` | `{ name, description, parameters }` | Provider-neutral JSON Schema |
| `tools.toOpenAI()` | `{ type: 'function', function: { name, description, parameters } }` | OpenAI Chat Completions (`openai` v5/v6) and OpenAI-compatible APIs |
| `tools.toAnthropic()` | `{ name, description, input_schema }` | Anthropic Messages API (`@anthropic-ai/sdk`) |
| `tools.toAiSdk({ jsonSchema })` | `{ [name]: { description, inputSchema, execute } }` | Vercel AI SDK v5 `ToolSet` |

The JSON Schema has `$schema` removed and non-recursive `$ref`s inlined (`$defs` is kept only for recursive schemas). OpenAI `strict` mode is not set, because strict mode requires every property to be required. For the OpenAI Responses API, flatten each entry: `{ type: 'function', ...tool.function }`.

The same formatters exist as functions for tools used outside an agent: `toOpenAITools([tool])`, `toAnthropicTools([tool])` (definitions or bound tools), `toAiSdkTools([tool.bind({ layers })], { jsonSchema })`, and `tool.toJsonSchema()`.

### Run a tool-call loop with `executeForModel`

`execute(input)` rejects with typed errors: `ToolInputError` (with `issues: { path, message }[]`), `ToolExecutionError` (the thrown value is in `cause`), `ToolOutputError` (the tool returned data that fails its own output schema, which is a bug in the tool) and `ToolTimeoutError`. Each error has a `_tag`.

`executeForModel(input)` never rejects for those failures. It resolves with a result to send back to the model, so the model can fix its arguments and retry:

```ts
type ToolModelResult<T> =
  | { ok: true; output: T }
  | {
      ok: false;
      error: {
        kind: 'invalid_input' | 'execution_error' | 'timeout' | 'invalid_output';
        message: string; // no stack traces
        issues?: { path: string; message: string }[]; // invalid_input only
      };
    };
```

Cancellation is not converted into a result: when the agent's `signal` (or a per-call `signal`) aborts, both methods reject with the signal's reason so the run stops.

OpenAI Chat Completions:

```ts
.logic(async ({ tools, signal, triggerEvent }) => {
  const byName = new Map(tools.toTools().map((tool) => [tool.schema.name, tool]));
  const messages: ChatCompletionMessageParam[] = [
    { role: 'user', content: triggerEvent.payload.message },
  ];

  while (true) {
    const response = await openai.chat.completions.create(
      { model, messages, tools: tools.toOpenAI() },
      { signal },
    );
    const message = response.choices[0].message;
    messages.push(message);
    if (!message.tool_calls?.length) break;

    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;
      const tool = byName.get(call.function.name);
      const result = tool
        ? await tool.executeForModel(JSON.parse(call.function.arguments), { toolCallId: call.id })
        : { ok: false, error: { message: `Unknown tool ${call.function.name}` } };
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
})
```

Anthropic Messages API:

```ts
const response = await anthropic.messages.create(
  { model, max_tokens: 1024, messages, tools: tools.toAnthropic() },
  { signal },
);
const toolResults = [];
for (const block of response.content) {
  if (block.type !== 'tool_use') continue;
  const result = await byName.get(block.name)?.executeForModel(block.input, { toolCallId: block.id });
  toolResults.push({
    type: 'tool_result',
    tool_use_id: block.id,
    content: JSON.stringify(result),
    is_error: !result?.ok,
  });
}
messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: toolResults });
```

Vercel AI SDK v5 runs the loop itself. Pass `jsonSchema` from `ai` so the SDK gets its own schema objects; the tools' `execute` receives the SDK's `toolCallId` and `abortSignal`, and their typed errors are reported back to the model as tool errors:

```ts
import { generateText, jsonSchema, stepCountIs } from 'ai';

const { text } = await generateText({
  model,
  prompt: triggerEvent.payload.message,
  tools: tools.toAiSdk({ jsonSchema }),
  stopWhen: stepCountIs(5),
  abortSignal: signal,
});
```

### Add a timeout and retries

Both are off by default:

```ts
export const fetchPageTool = Tool.of({ name: 'fetchPage', description: 'Fetch a web page' })
  .input(S.Struct({ url: S.String }))
  .output(S.Struct({ html: S.String }))
  .timeout('10 seconds')
  .retry({ times: 2, backoff: { base: '200 millis', factor: 2, max: '2 seconds' } })
  .define(async ({ input, signal }) => {
    const response = await fetch(input.url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { html: await response.text() };
  });
```

- `.timeout(duration)` fails an attempt with `ToolTimeoutError` and aborts the tool's `signal` with that error, so tools that pass `signal` on stop their work. The agent's own signal is not aborted.
- `.retry({ times, backoff? })` re-runs the tool only when it throws (`ToolExecutionError`, whose `attempts` counts the runs). Invalid input, invalid output and timeouts are never retried, and no retry starts after the signal aborted; an abort also cuts a backoff wait short. Retries keep the same `toolCallId`. Without `backoff`, retries start immediately; with it, retry `n` waits `base * factor^(n - 1)`, capped at `max` (`factor` defaults to `2`).

### Tracing

When an agent calls a tool from its `tools` collection, each call opens a `tool` span named after the tool in the invocation's `tracing` scope, with the raw input, and ends it with the output or the typed error. Tools bound by hand can pass a scope: `tool.bind({ layers, tracing })`. A failing tracer never fails the tool.

---

## How to chain agents across channels

Use extra channels so one agent's output becomes another agent's input. Subscribe each agent to the channels it should listen on; publish to the channels downstream agents or the client should see.

### Main assistant + background worker

```ts
// network/network.ts
export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent }) => {
    const client = createChannel('client').proxy(proxy.sse());
    const sub = createChannel('sub');

    registerAgent(assistantAgent).subscribe(mainChannel).publishTo(client).publishTo(sub);
    registerAgent(backgroundSubAgent).subscribe(sub).publishTo(sub);
  },
);
```

The main agent handles user messages on `mainChannel` and can emit task events onto `sub`. The worker subscribes to `sub` only — it never sees raw HTTP traffic.

```ts
// network/sub-agent.ts
export const backgroundSubAgent = AgentFactory.run()
  .listensTo([SubAgentTaskRequested])
  .emits([SubAgentTaskCompleted, ToolUsedEvent])
  .tools([...coreAssistantTools])
  .logic(async ({ triggerEvent, emit }) => {
    // ... run work ...
    emit(SubAgentTaskCompleted.make({ taskId, status: 'completed', result }));
  })
  .produce({});
```

See [Patterns: Agent Chain](../guides/patterns.md#agent-chain-sequential) and `examples/assistant-app/src/network/network.ts`.

---

## How to delegate work and wait for a reply

Use `emitAndAwait` inside agent logic or tool handlers to emit an event and pause until a matching reply arrives on the network (scoped by `correlationId`).

### From a tool — spawn a sub-agent

```ts
// network/tools/spawn-sub-agent.tool.ts
.define(async ({ input, emit, emitAndAwait, toolCallId }) => {
  const reply = await emitAndAwait(
    SubAgentTaskRequested.make({ taskId: toolCallId, prompt: input.prompt }),
    SubAgentTaskCompleted.is,
    { timeout: '1 minute' },
  );

  return {
    taskId: reply.payload.taskId,
    status: reply.payload.status,
    result: reply.payload.result,
  };
});
```

The worker on the `sub` channel must emit `SubAgentTaskCompleted` while the tool is waiting. Correlation ids are copied from the triggering event meta, so the matcher only accepts the paired reply.

### From agent logic

```ts
.logic(async ({ triggerEvent, emit, emitAndAwait }) => {
  const reply = await emitAndAwait(
    taskRequested.make({ id: triggerEvent.payload.id }),
    (event) => event.name === 'task-result',
    { timeout: '30 seconds' },
  );
  emit(finalEvent.make({ result: reply.payload }));
})
```

The reply must come from a **different** subscriber while the caller is blocked — same-agent loopbacks time out. See [Patterns: Loopback](../guides/patterns.md#loopback--emit-and-await).

---

## How to add auth to an exposed endpoint

Reject unauthenticated requests before any start event is published: return `{ allowed: false, status, message }` from the `auth` callback on `registerSSEStream`. For allowed requests, return the **principal** they act for: it namespaces conversation history, so a client-supplied `contextId` (e.g. `x-correlation-id`) can only reach that principal's conversations.

```ts
// app/api/chat/route.ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [MessageEvent],
    auth: async (req) => {
      const user = await verifyToken(req.request?.headers?.get('authorization'));
      if (!user) {
        return { allowed: false, message: 'Invalid token', status: 401 };
      }
      return { allowed: true, principal: { id: user.id, tenantId: user.tenantId } };
    },
  }),
);
```

Forward the same header from the client `fetch` call. Requests allowed without a principal (or with no `auth` at all) share one anonymous namespace, where anyone who knows a `contextId` reads that conversation. See [Auth + Multi-Tenant](../guides/auth-multitenant.md).

---

## How to pass user or tenant context into events

The principal `auth` returns reaches agents as `ctx.principal` (and tools as `principal`), and `onRequest` receives it too. To also carry scope fields in the payload, enrich the start event in `onRequest`:

```ts
// network/events.ts
export const UserRequestEvent = AgentNetworkEvent.of(
  'user-request',
  S.Struct({ query: S.String, userId: S.String, tenantId: S.String }),
);
```

```ts
// app/api/chat/route.ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [UserRequestEvent],
    auth: authenticate, // returns { allowed: true, principal: { id, tenantId } }
    onRequest: async ({ emitStartEvent, req, payload, principal }) => {
      emitStartEvent({
        contextId: req.contextId ?? crypto.randomUUID(),
        runId: req.runId ?? crypto.randomUUID(),
        event: UserRequestEvent.make({
          ...(payload as { query: string }),
          userId: principal?.id ?? 'anonymous',
          tenantId: String(principal?.tenantId ?? 'none'),
        }),
      });
    },
  }),
);
```

Use `contextId` from the request (or a header like `x-correlation-id`) to group events for the same conversation.

---

## How to use conversation history in agent logic

`history` reads the conversation's durable events from the network's store, on demand. `history.context({ limit })` returns the newest `limit` events of the current `contextId` (across runs, oldest first); filter by event type to rebuild chat history before calling an LLM. The trigger is already in history, so leave it out when you add it yourself.

```ts
// network/example-agent.ts
.logic(async ({ triggerEvent, emit, history }) => {
  if (!MessageEvent.is(triggerEvent)) return;

  const message = triggerEvent.payload.message;
  const role = triggerEvent.payload.role as 'user' | 'assistant';

  const { events } = await history.context({ limit: 50 });
  const messageHistory = events
    .filter(MessageEvent.is)
    .filter((event) => event.meta.eventId !== triggerEvent.meta.eventId);

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...messageHistory.map((event) => ({
        role: event.payload.role as 'user' | 'assistant',
        content: event.payload.message,
      })),
      { role, content: message },
    ],
  });
  // ... emit stream chunks ...
})
```

`history.run()` returns the current run's events only; `history.context()` spans the whole conversation. Page back with `history.context({ limit, before: page.cursor })`. History is scoped to the request's principal, and transient events (token deltas) are never in it. See [Event history and stores](../api-reference/agent-network.md#event-history-and-stores).

---

## How to aggregate stream events

Use `EventAggregator` to watch a stream of chunk events and emit a derived event when a condition is met — without adding another full agent.

```ts
// network/aggregator.ts
const messageAggregator = EventAggregator.listensTo([MessageStreamChunkEvent])
  .emits([MessageEvent])
  .emitWhen(({ triggerEvent }) => {
    return triggerEvent.payload.role === 'assistant' && triggerEvent.payload.isFinal;
  })
  .mapToEmit(({ emit }) => {
    emit(MessageEvent.make({ role: 'assistant', message: 'Stream complete' }));
  });
```

```ts
// network/network.ts
registerAggregator(messageAggregator).subscribe(client).publishTo(client);
```

See `examples/core-example/app/sse/api/network.ts` for a working aggregator on the client channel.

---

## How to filter which events the client receives

Limit the SSE stream to specific event names so internal or debug events never reach the browser.

```ts
// app/api/chat/route.ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    events: ['message-stream-chunk', 'message', 'agent-error'],
    triggerEvents: [MessageEvent],
  }),
);
```

You can also declare allowed events on the channel itself. Unlike the stream's `events` filter, this is enforced for every publisher: agents publish other events only to their other channels (an emit no publish channel accepts throws), external publishes of other events are refused, and `AgentNetwork.setup()` throws on wiring that contradicts it:

```ts
// network/network.ts
const client = createChannel('client')
  .events([MessageStreamChunkEvent, MessageEvent])
  .proxy(proxy.sse());
```

---

## How to handle errors and surface them to the UI

Unhandled errors already reach the client: by default an agent that throws ends the run with `m4trix:run.failed` and a sanitized `{ name, message, kind }` (see [How to end or cancel a run](#how-to-end-or-cancel-a-run)). For domain-specific errors, define an error event, emit it from a `try/catch` in agent logic, and include it in the SSE filter so the client can render failures.

```ts
// network/events.ts
export const AgentErrorEvent = AgentNetworkEvent.of(
  'agent-error',
  S.Struct({ message: S.String }),
);
```

```ts
// network/my-agent.ts
.logic(async ({ triggerEvent, emit }) => {
  try {
    const result = await doWork(triggerEvent.payload);
    emit(MessageEvent.make({ role: 'assistant', message: result }));
  } catch (e) {
    emit(AgentErrorEvent.make({ message: String(e) }));
  }
})
```

```ts
// app/_hooks/use-sse-agent-chat.ts
if (event.name === 'agent-error') {
  setError(event.payload.message);
  finish();
}
```

---

## How to inject shared services with dependency layers

Declare layers on the network, implement them with `.make()`, and pass instances when starting the runtime. Agents and tools access services through `layers.LayerName`.

### Define and register a layer

```ts
// network/layers/open-ai.ts
export const OpenAiLayer = DependencyLayer.of({
  name: 'OpenAi',
  config: S.Struct({ model: S.String }),
}).define<{ client: OpenAI }>();
```

```ts
// network/network.ts
export const network = AgentNetwork.dependsOn([OpenAiLayer, WithFileSystemLayer]).setup(
  ({ mainChannel, createChannel, proxy, registerAgent }) => {
    // ... wire agents ...
  },
);
```

### Provide layer instances at runtime

For a long-lived server, start the plane once and reuse it across requests:

```ts
// server/runtime.ts
const plane = await Effect.runPromise(
  network.run({
    layers: {
      OpenAi: OpenAiLayer.make({ client: new OpenAI(), config: { model: 'gpt-4o' } }),
      WithFileSystemLayer: withFileSystem({ rootDir: './agent-tmp' }),
    },
  }),
);

// app/api/chat/route.ts — reuse the plane
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [MessageEvent],
    plane,
  }),
);
```

```ts
// network/my-agent.ts
.logic(async ({ layers, emit }) => {
  const response = await layers.OpenAi.client.chat.completions.create({
    model: layers.OpenAi.config.model,
    messages: [/* ... */],
  });
  // ...
})
```

See `examples/assistant-app/src/server/assistant-runtime.ts`.

---

## How to run multiple agents in parallel

Subscribe several agents to the same channel so one incoming event triggers all of them at once. Each agent can publish to the same or different output channels.

```ts
// network/network.ts
const main = mainChannel('main');
const client = createChannel('client').proxy(proxy.sse());
const analytics = createChannel('analytics');

registerAgent(chatAgent).subscribe(main).publishTo(client);
registerAgent(loggerAgent).subscribe(main);
registerAgent(analyticsAgent).subscribe(main).publishTo(analytics);
```

```ts
// network/logger-agent.ts
export const loggerAgent = AgentFactory.run()
  .logic(async ({ triggerEvent }) => {
    console.log('[event]', triggerEvent.name, triggerEvent.payload);
  })
  .produce({});
```

Use this for parallel side-effects (logging, metrics, processing) on the same trigger. See [Patterns: Fan-Out](../guides/patterns.md#fan-out).

---

## How to add tracing to agent runs

Pass a `networkTracer` when setting up the network. Agents receive a `tracing` scope in `.logic()` to record LLM and tool spans.

```ts
// network/network.ts
import { toM4trixTracer } from '@m4trix/tracing';

export const network = AgentNetwork.setup(
  ({ mainChannel, registerAgent }) => {
    // ... wire agents ...
  },
  {
    consoleTracing: process.env.DEBUG === '1',
    networkTracer: toM4trixTracer(tracer),
  },
);
```

```ts
// network/assistant-agent.ts
.logic(async ({ tracing, emit }) => {
  const llm = tracing.startRun('llm', 'gpt-4o', { prompt: 'hello' });
  // ... call model ...
  await llm.end({ text: finalResponse });
})
```

Every event carries `meta.runId`, `meta.contextId`, and `meta.correlationId` for correlation. See [Error Handling + Observability](../guides/error-handling-observability.md).

---

## How to reuse streaming logic with a skill

Extract reusable streaming behavior into a `Skill`, then call `invokeStream()` from an agent and map chunks to network events.

```ts
// skills/reasoning.skill.ts
export const reasoningSkill = Skill.of()
  .input(S.Struct({ problemToSolve: S.String }))
  .chunk(S.String)
  .done(S.String)
  .define(async ({ input, emit }) => {
    const stream = await openai.chat.completions.create({
      model: 'o4-mini',
      stream: true,
      messages: [/* ... */],
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) emit(text);
    }
    return extractFinalAnswer(fullResponse);
  });
```

```ts
// network/reasoning-agent.ts
import { Done } from '@m4trix/core';

.logic(async ({ triggerEvent, emit }) => {
  const stream = reasoningSkill.invokeStream({
    problemToSolve: triggerEvent.payload.problemToSolve,
  });

  for await (const chunk of stream) {
    if (Done.is(chunk)) {
      emit(ReasoningForProblemCompleted.make({ result: chunk.done }));
    } else {
      emit(ReasoningForProblemThoughtChunkCreated.make({ chunk }));
    }
  }
})
```

`invokeStream()` yields each chunk as soon as `define` emits it, then a final `Done`. An error thrown in `define` (or an invalid chunk) rejects the iteration after the chunks emitted before it. If the consumer stops early (`break`, `return`), the skill's `signal` is aborted so its work stops; the `signal` you passed in is not aborted. `invoke()` still resolves with all chunks and the done value once `define` finishes.

Skills are testable units; agents handle event wiring. See `examples/core-example/skills/reasoning.skill.ts`.

---

## How to end or cancel a run

A run ends exactly once, and its stream closes after the run-end event. Declare the event that finishes a run, or end it from logic. Pass `signal` to long calls so they stop with the run.

### Declare a terminal event

```ts
// network/network.ts
AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
  // ...
  endsOn(AnswerEvent);
});
```

### End the run from agent logic

```ts
// network/my-agent.ts
.logic(async ({ triggerEvent, emit, complete, fail, signal }) => {
  const res = await fetch(searchUrl(triggerEvent.payload.query), { signal });
  if (!res.ok) return fail(new Error(`Search failed: ${res.status}`));
  emit(AnswerEvent.make({ answer: await res.text() }));
  complete(); // published after the answer above
})
```

### Choose the failure policy and safety net

```ts
// network/network.ts
AgentNetwork.setup(setupFn, { onAgentError: 'continue' }); // default: 'fail'
```

```ts
// app/api/chat/route.ts
// Idle = no agent running and no events. A long LLM call or approval wait is not idle.
registerSSEStream({ channel: 'client', idleTimeout: '2 minutes', maxDuration: '15 minutes' });
```

### React to the end on the client

```ts
// app/_hooks/use-sse-agent-chat.ts
if (event.name === 'm4trix:run.failed') setError(event.payload.error.message);
if (event.name === 'm4trix:agent.error') warn(event.payload.error.message); // 'continue' policy
// The response closes after m4trix:run.completed / m4trix:run.failed.
```

When the client disconnects, the run is cancelled: agents' `signal` aborts and `m4trix:run.cancelled` reaches the tracer. See [Run Lifecycle](../api-reference/io-adapters.md#run-lifecycle).

---

## Related

- [Hello World](hello-world.md) — minimal end-to-end setup
- [What's Happening](whats-happening.md) — how events and channels fit together
- [Patterns](../guides/patterns.md) — request/response, fan-out, chains
- [Common Recipes](../examples/common-recipes.md) — more copyable snippets
