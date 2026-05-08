# Common Recipes

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
.logic(async ({ triggerEvent, emit }) => {
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    stream: true,
    messages: [{ role: 'user', content: triggerEvent.payload.query }],
  });
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      emit({ name: 'response', payload: { text: content, isFinal: false } });
    }
  }
  emit({ name: 'response', payload: { text: '', isFinal: true } });
})
```

## Auth in expose()

```ts
const api = network.expose({
  protocol: 'sse',
  auth: async (req) => {
    const token = req.request?.headers?.get?.('authorization');
    if (!token || !isValid(token)) {
      return { allowed: false, message: 'Invalid token', status: 401 };
    }
    return { allowed: true };
  },
  select: { channels: 'client' },
});
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
