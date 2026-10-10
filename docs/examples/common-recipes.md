---
title: "Common Recipes"
---

Copyable snippets for frequent patterns.

## Echo Agent

```ts
const agent = AgentFactory.run()
  .listensTo([requestEvent])
  .emits([responseEvent])
  .logic(async ({ triggerEvent, emit }) => {
    emit({
      name: 'agent-response',
      payload: { answer: triggerEvent.payload.query, done: true },
    });
  })
  .produce({});
```

## Streaming LLM Agent

```ts
.logic(async ({ triggerEvent, emit, signal }) => {
  const stream = await openai.chat.completions.create(
    {
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: triggerEvent.payload.query }],
    },
    { signal }, // stops the call when the run ends or the client disconnects
  );
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      emit({ name: 'response', payload: { text: content, isFinal: false } });
    }
  }
  emit({ name: 'response', payload: { text: '', isFinal: true } });
})
```

## End the Run

Declare the terminal event in setup, or end the run from logic:

```ts
AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
  // ...
  endsOn(responseEvent, (event) => event.payload.isFinal);
});

// or, in agent logic:
.logic(async ({ emit, complete }) => {
  emit({ name: 'agent-response', payload: { answer: '42', done: true } });
  complete();
})
```

Without either, the run ends on the `idleTimeout` safety net (default 60 seconds after its agents went quiet) as `m4trix:run.failed`. Time spent inside an agent invocation never counts as idle; `maxDuration` catches stuck agents. Tune both per expose:

```ts
registerSSEStream({ channel: 'client', idleTimeout: '5 minutes', maxDuration: Infinity });
```

## Auth in expose()

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    auth: async (req) => {
      const user = await verifyToken(req.request?.headers?.get?.('authorization'));
      if (!user) {
        return { allowed: false, message: 'Invalid token', status: 401 };
      }
      // The principal namespaces history and reaches agents as `ctx.principal`.
      return { allowed: true, principal: { id: user.id } };
    },
  }),
);
```

## Catch-All Logger

```ts
const loggerAgent = AgentFactory.run()
  .logic(async ({ triggerEvent }) => {
    console.log('[event]', triggerEvent.name, triggerEvent.payload);
  })
  .produce({});
registerAgent(loggerAgent).subscribe(main).subscribe(processing);
```

## Error Event

Unhandled errors fail the run with `m4trix:run.failed` by default (see `onAgentError`). Emit your own event when the client should get a domain-specific error instead:

```ts
const errorEvent = AgentNetworkEvent.of('agent-error', S.Struct({ message: S.String }));

// In logic:
try {
  const result = await doWork(triggerEvent.payload);
  emit({ name: 'agent-response', payload: { answer: result, done: true } });
} catch (e) {
  emit({ name: 'agent-error', payload: { message: String(e) } });
}
```
