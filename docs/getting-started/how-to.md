---
title: "How to ..."
description: "Task-focused answers with snippet-first examples for common agent workflows."
---

Short answers to specific questions. Each section shows the minimum code to wire pieces together — partial snippets across files, not full apps. Fifteen topics below; use the table of contents to jump.

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
  ({ mainChannel, createChannel, proxy, registerAgent }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(exampleAgent).subscribe(mainChannel).publishTo(client);
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
.logic(async ({ triggerEvent, emit, contextEvents }) => {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [/* ...history from contextEvents... */],
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

Reject unauthenticated requests before any start event is published. Return `{ allowed: false, status, message }` from the `auth` callback on `registerSSEStream`.

```ts
// app/api/chat/route.ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [MessageEvent],
    auth: async (req) => {
      const token = req.request?.headers?.get('authorization');
      if (!token || !isValid(token)) {
        return { allowed: false, message: 'Invalid token', status: 401 };
      }
      return { allowed: true };
    },
  }),
);
```

Forward the same header from the client `fetch` call. See [Auth + Multi-Tenant](../guides/auth-multitenant.md).

---

## How to pass user or tenant context into events

Enrich the start event in `onRequest` so agents receive `userId`, `tenantId`, or other scope fields in the payload.

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
    onRequest: async ({ emitStartEvent, req, payload }) => {
      const user = await getUserFromRequest(req);
      if (!user) return;

      emitStartEvent({
        contextId: req.contextId ?? crypto.randomUUID(),
        runId: req.runId ?? crypto.randomUUID(),
        event: UserRequestEvent.make({
          ...(payload as { query: string }),
          userId: user.id,
          tenantId: user.tenantId,
        }),
      });
    },
  }),
);
```

Use `contextId` from the request (or a header like `x-correlation-id`) to group events for the same conversation.

---

## How to use conversation history in agent logic

`contextEvents` exposes prior events for the current `contextId`. Filter by event type to rebuild chat history before calling an LLM.

```ts
// network/example-agent.ts
.logic(async ({ triggerEvent, emit, contextEvents }) => {
  if (!MessageEvent.is(triggerEvent)) return;

  const message = triggerEvent.payload.message;
  const role = triggerEvent.payload.role as 'user' | 'assistant';

  const messageHistory = contextEvents.all
    .filter(MessageEvent.is)
    .filter((event) => event.payload.message !== message || event.payload.role !== role);

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

`runEvents` contains events from the current run only; `contextEvents` spans the full conversation context.

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

You can also declare allowed events on the channel itself:

```ts
// network/network.ts
const client = createChannel('client')
  .events([MessageStreamChunkEvent, MessageEvent])
  .proxy(proxy.sse());
```

---

## How to handle errors and surface them to the UI

Define an error event, emit it from a `try/catch` in agent logic, and include it in the SSE filter so the client can render failures.

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
export const OpenAiLayer = DepedencyLayer.of({
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

Skills are testable units; agents handle event wiring. See `examples/core-example/skills/reasoning.skill.ts`.

---

## How to spawn agents at runtime

Use `spawner` to create agents on demand when a spawn event arrives — useful for per-tenant or per-session workers.

```ts
// network/events.ts
export const SpawnEvent = AgentNetworkEvent.of(
  'daemon-spawn',
  S.Struct({
    kind: S.String,
    params: S.Record({ key: S.String, value: S.Unknown }),
  }),
);
```

```ts
// network/network.ts
spawner(AgentFactory)
  .listen(main, SpawnEvent)
  .registry({ analyst: analystFactory, writer: writerFactory })
  .defaultBinding(({ kind }) => ({
    subscribe: ['main'],
    publishTo: kind === 'analyst' ? ['client'] : [],
  }))
  .onSpawn(({ factory, payload, spawn }) => {
    const agent = factory.produce(payload.params);
    spawn(agent);
    return agent;
  });
```

The spawn event payload can carry `tenantId` or custom params; `onSpawn` selects the factory and calls `spawn(agent)` to register bindings. See [Auth + Multi-Tenant](../guides/auth-multitenant.md#multi-tenant-agent-selection).

---

## Related

- [Hello World](hello-world.md) — minimal end-to-end setup
- [What's Happening](whats-happening.md) — how events and channels fit together
- [Patterns](../guides/patterns.md) — request/response, fan-out, chains
- [Common Recipes](../examples/common-recipes.md) — more copyable snippets
