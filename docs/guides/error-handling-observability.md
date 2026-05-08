# Error Handling + Observability Hooks

## Error Handling in Agents

Handle errors inside your agent logic and emit error events:

```ts
const errorEvent = AgentNetworkEvent.of('agent-error', S.Struct({ message: S.String }));

const agent = AgentFactory.run()
  .listensTo([requestEvent])
  .emits([responseEvent, errorEvent])
  .logic(async ({ triggerEvent, emit }) => {
    try {
      const result = await doWork(triggerEvent.payload);
      emit({ name: 'agent-response', payload: { answer: result, done: true } });
    } catch (e) {
      emit({ name: 'agent-error', payload: { message: String(e) } });
    }
  })
  .produce({});
```

Ensure the client channel streams both response and error events so the UI can show errors.

## Event Filtering

Stream only specific events to the client:

```ts
const api = network.expose({
  protocol: 'sse',
  select: {
    channels: 'client',
    events: ['agent-response', 'agent-error'],
  },
});
```

## Observability Hooks

### onRequest

Use `onRequest` to log, trace, or enrich before the start event is published:

```ts
const api = network.expose({
  protocol: 'sse',
  onRequest: async ({ emitStartEvent, req, payload }) => {
    const traceId = crypto.randomUUID();
    console.log('[trace]', traceId, payload);
    emitStartEvent({ ...payload, traceId });
  },
  select: { channels: 'client' },
});
```

### Catch-All Logger Agent

Register a catch-all agent to log every event:

```ts
const loggerAgent = AgentFactory.run()
  .logic(async ({ triggerEvent }) => {
    console.log('[event]', triggerEvent.name, triggerEvent.meta.runId, triggerEvent.payload);
  })
  .produce({});

registerAgent(loggerAgent).subscribe(main).subscribe(processing);
```

### Event Meta

Every event has `meta.runId`, `meta.contextId`, `meta.correlationId`, `meta.causationId`, and `meta.ts`. Use these for distributed tracing and correlation.
