---
title: "Error Handling + Observability Hooks"
---

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

## Unhandled Agent Errors

An agent that throws (or rejects) is handled by the network's `onAgentError` policy:

- **`'fail'`** (default) — the run ends with `m4trix:run.failed`, the run's other in-flight agents are aborted through their `signal`, and the stream closes.
- **`'continue'`** — `m4trix:agent.error` is published and the run keeps going.

```ts
const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent }) => {
    // ...
  },
  { onAgentError: 'continue' },
);
```

Both events carry a sanitized error (`name`, `message` and, for run failures, `kind`); stack traces never reach the client. To fail the run on purpose, call `fail(error)` in logic; it fails the run under either policy.

```ts
.logic(async ({ triggerEvent, fail }) => {
  if (!triggerEvent.payload.query) return fail(new Error('Empty query'));
  // ...
})
```

On the client, check for the run-end events:

```ts
import { isRunEndEnvelope, RunLifecycleEvent } from '@m4trix/core/matrix';

if (isRunEndEnvelope(envelope) && envelope.name === RunLifecycleEvent.failed) {
  showError(envelope.payload.error.message); // kind: 'agent-error' | 'idle-timeout' | 'max-duration' | 'limit-exceeded' | 'store-error' | 'invalid-emit' | 'run-unavailable' | 'stream-error'
}
```

`store-error` means a durable event could not be written to the network's store after 3 attempts: the event was not delivered and the run failed. Clients get a generic `NetworkStoreError` message; tracers get the store's own error as its `cause`. See [Write failures and ordering](../api-reference/agent-network.md#write-failures-and-ordering).

## Validation

Effect schemas on events, params and channels are checked at runtime, not only in types: with LLM-generated payloads, a type annotation is a hope, not a guarantee. Every boundary reports problems as `issues: { path, message }[]` (the same shape as tool input errors).

| Boundary | Check | On failure |
|----------|-------|------------|
| HTTP request (`expose`) | Body is valid JSON; payload decodes with the trigger event's schema; `emitStartEvent` events decode with their definition | `ExposeValidationError`: the adapters answer `400 { error: 'invalid_request', issues }`. Runs after `auth`; no run, agent or trace starts |
| Agent / tool emit | Event declared in `.emits()`; payload decodes with its schema; a publish channel accepts it | `EmitValidationError` thrown from `emit` (rejected from `emitAndAwait`); the event is not published; the invocation fails even if caught, so `onAgentError` applies (`kind: 'invalid-emit'`) |
| Channel `.events([...])` | Published event is declared on the channel (`m4trix:*` always pass) | Agents: as above. External publishes: `publish` resolves `false` and the network `logger` warns |
| `.produce(params)` | Params decode with the `.params()` schema | `AgentParamsError` |
| `AgentNetwork.setup()` | Wiring: emitted and listened events vs. channel declarations | `NetworkWiringError` listing every contradiction; smells go to `logger.warn` |

Decoded values are what flows on: a valid start event, emit or params value that is not exactly of the schema's type (e.g. raw model output) is decoded, so schema transformations apply and unknown properties are dropped; a value already of the type (from `event.make()`) passes unchanged.

```ts
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String, confidence: S.NumberFromString }));

const agent = AgentFactory.run()
  .listensTo([question])
  .emits([answer])
  .logic(async ({ emit }) => {
    const output = JSON.parse(await llm(prompt)); // e.g. { text: 'Paris', confidence: '0.9', notes: '…' }
    emit({ name: 'answer', payload: output }); // published as { text: 'Paris', confidence: 0.9 }
  })
  .produce({});
```

An invalid emit fails the run with a sanitized error; its message names the event and the offending paths, never the payload values (those could be secrets an LLM echoed). Tracers get the original `EmitValidationError`, whose `issues` carry the full schema messages:

```ts
if (isRunEndEnvelope(envelope) && envelope.name === RunLifecycleEvent.failed) {
  const { error } = envelope.payload;
  if (error.kind === 'invalid-emit') console.warn(`agent emitted an invalid "${error.event}"`, error.message);
}
```

To let a model correct itself instead of failing the run, validate before emitting, e.g. with the event's `makeEffect()` / `decodePayload()`, and feed the issues back to the model. An agent without `.emits()` may emit nothing; declare every event an agent (or its tool) publishes. In tests, assert a clean wiring with `expect(network.validate()).toEqual({ errors: [], warnings: [] })`.

## Run Limits, Usage and Budgets

Every run has structural limits that catch runaway agents, on by default:

- **`maxDepth`** (default `25`): every event carries `meta.depth`, its distance from the run's start event (depth `0`). An agent handling an event at depth `d` emits at `d + 1`, through `emit`, `emitAndAwait` and tool emits alike. Two agents triggering each other (A → B → A …) hit the limit after 25 hops.
- **`maxEvents`** (default `1000`): durable events published in the run, start event included. Transient events (token deltas, progress) and the runtime's `m4trix:*` events don't count: a streamed answer can be thousands of deltas, and loops among transient events still hit `maxDepth`.

Agents and tools report what their model calls used with `reportUsage()`. Core is provider-agnostic: map your SDK's usage object yourself.

```ts
.logic(async ({ reportUsage, signal }) => {
  const res = await llm.invoke(messages, { signal });
  reportUsage({
    model: 'gpt-4o',
    inputTokens: res.usage.input_tokens,   // cache reads/writes included
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cached_tokens,
    costUsd: priceOf(res.usage),           // optional
  });
})
```

`totalTokens` defaults to `inputTokens + outputTokens`. The run sums every report, overall and per `model`, passes each one to the tracer's `onUsage`, and adds the totals as `usage` to the run-end payload (`m4trix:run.completed`, `failed` or `cancelled`) once anything was reported. Invalid numbers (negative, `NaN`) are dropped with a warning.

Optional budgets, off by default, fail the run once reported usage goes over them: **`maxTokens`** (against `totalTokens`) and **`maxCostUsd`**. The report that crossed the line is still counted.

Configure all four per network, per plane or per exposed run; the most specific wins and `Infinity` disables a limit:

```ts
const network = AgentNetwork.setup(setupFn, { maxDepth: 10, maxCostUsd: 0.5 });
const plane = yield* network.run({ maxEvents: 5_000 });
const api = network.expose(registerSSEStream({ channel: 'client', maxTokens: 200_000 }));
```

A run over a limit fails like any other: `m4trix:run.failed` with `error.kind: 'limit-exceeded'`, the `limit` (`'depth' | 'events' | 'tokens' | 'cost'`) and its `max`, its agents are aborted through their `signal`, and the event that would have exceeded `maxDepth` / `maxEvents` is not delivered (`plane.publish` resolves to `false` for it). The tracer receives a `RunLimitExceededError`.

```ts
if (isRunEndEnvelope(envelope) && envelope.name === RunLifecycleEvent.failed) {
  const { error, usage } = envelope.payload;
  if (error.kind === 'limit-exceeded') console.warn(`run hit ${error.limit} (max ${error.max})`, usage);
}
```

## Cancellation

Agent logic, tool `execute` and skill `define` receive a `signal: AbortSignal`. It aborts when the run ends: completed, failed, timed out, or cancelled because the client disconnected. Pass it on so LLM and HTTP calls stop with the run:

```ts
.logic(async ({ triggerEvent, emit, signal }) => {
  const res = await fetch(searchUrl(triggerEvent.payload.query), { signal });
  // ...
})
```

Emits after the run ended are dropped. A cancelled run cannot reach the disconnected client, but `m4trix:run.cancelled` is still stored and passed to the tracer.

## Event Filtering

Stream only specific events to the client:

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    events: ['agent-response', 'agent-error'],
  }),
);
```

## Logger

Everything the network reports without failing on it goes to the `logger` setup option: wiring warnings, publishes refused by a channel or for another principal's run, a throwing `endsOn` predicate, invalid `reportUsage()` numbers, failing tracer hooks or `onMetric` handlers, run-end events the store could not keep, failing subscribers, unserializable SSE payloads and stream failures in the adapters. Core never writes to `console` itself when a logger is given (the opt-in `consoleTracing` aside).

```ts
import pino from 'pino';

const log = pino();
const network = AgentNetwork.setup(setup, {
  // `{ debug?, info?, warn, error? }`, each `(message, data?)`.
  logger: {
    warn: (message, data) => log.warn({ data }, message),
    error: (message, data) => log.error({ err: data }, message),
  },
});
```

- Only `warn` is required: `error` falls back to `warn`, `debug` / `info` are dropped when missing. `console` fits as is (and is the default).
- A logger that throws is ignored for that call; logging never fails a run.
- `NextEndpoint` / `ExpressEndpoint` log to the network's logger too; pass `logger` to an adapter to override it.

| Level | What |
|-------|------|
| `warn` | Wiring smells, refused publishes, `endsOn` predicate errors, invalid usage reports, tracer hook failures, the first `onMetric` failure, lossy SSE payloads |
| `error` | Lifecycle events the store could not keep, failing subscribers, runtime defects in the plane, SSE stream failures after the response started, Express errors without `next` |

## Metrics

`onMetric` receives vendor-neutral measurements: map them onto OpenTelemetry, Prometheus, StatsD or your APM by `name` (stable), `kind` (`'histogram'` or `'counter'`) and `unit`. Attributes are low-cardinality only: never payloads, run or context ids, or principal claims.

```ts
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('m4trix');
const instruments = new Map();

const network = AgentNetwork.setup(setup, {
  onMetric: (metric) => {
    let instrument = instruments.get(metric.name);
    if (!instrument) {
      instrument =
        metric.kind === 'counter'
          ? meter.createCounter(metric.name, { unit: metric.unit })
          : meter.createHistogram(metric.name, { unit: metric.unit });
      instruments.set(metric.name, instrument);
    }
    if (metric.kind === 'counter') instrument.add(metric.value, metric.attributes);
    else instrument.record(metric.value, metric.attributes);
  },
});
```

| Name | Kind | Unit | Attributes | When |
|------|------|------|------------|------|
| `m4trix.run.duration_ms` | histogram | `ms` | `status` (`completed` / `failed` / `cancelled`), `reason` | Run end: first event to run end. `reason` is the completion reason (`terminal-event`, `agent`), the failure `kind` (`agent-error`, `idle-timeout`, …) or the cancel reason (`client-abort`, `stream-closed`) |
| `m4trix.run.events` | histogram | `{event}` | `status`, `durability` (`durable` / `transient`) | Run end, once per durability: events the run published (`m4trix:*` excluded) |
| `m4trix.run.tokens` | histogram | `{token}` | `status`, `type` (`input` / `output` / `total`) | Run end, when usage was reported |
| `m4trix.run.cost_usd` | histogram | `USD` | `status` | Run end, when usage was reported |
| `m4trix.agent.invocation.duration_ms` | histogram | `ms` | `agentId`, `status` (`ok` / `error` / `cancelled`) | Each agent invocation |
| `m4trix.mailbox.depth` | histogram | `{event}` | `agentId` | Each event queued for an agent in a run: the queue's length after it |
| `m4trix.store.append.duration_ms` | histogram | `ms` | `status` (`ok` / `error`) | Each durable event's store write, retries included |
| `m4trix.store.append.errors` | counter | `{error}` | `final` (no retry follows) | Each failed store write attempt |

`NetworkMetric` is a discriminated union on `name`, so a `switch (metric.name)` narrows `attributes`. The handler runs synchronously on the hot path: keep it cheap (hand values to a metrics SDK, don't do I/O). A throwing handler never breaks the network; its first failure is logged as a warning, later ones are not.

## Observability Hooks

### onRequest

Use `onRequest` to log, trace, or enrich before the start event is published:

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    onRequest: async ({ emitStartEvent, req, payload }) => {
      const traceId = crypto.randomUUID();
      console.log('[trace]', traceId, payload);
      emitStartEvent({
        contextId: req.contextId ?? crypto.randomUUID(),
        runId: req.runId ?? crypto.randomUUID(),
        event: messageEvent.make({ ...payload, traceId }),
      });
    },
  }),
);
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

Every event has `meta.runId` and `meta.contextId`. On publish the plane fills in a unique `meta.eventId`, the publish time `meta.ts` and `meta.depth` (`0` for events published from outside the run's agents) when they are missing. Everything an agent emits gets `meta.causationId` (the `eventId` of the event it was handling), `depth + 1`, and its trigger's `meta.correlationId`; `emitAndAwait` requests get a fresh `correlationId` that replies inherit. Use these for distributed tracing and correlation.

### NetworkTracer

Core exposes a pluggable `NetworkTracer` interface. Configure tracing when defining the network; `network.expose()` inherits those defaults. `onRunEnd(meta, error, { status })` and `onAgentInvokeEnd(scope, error, { status })` receive a `status` of `'ok'`, `'error'` or `'cancelled'`. A failed run gets its original error (agent error or `RunTimeoutError`); an invocation gets the agent's error, or an `AgentAbortedError` when its run failed or was cancelled mid-invocation. A cancelled run (client gone) is `status: 'cancelled'`, not an error: `error` is still set (`RunCancelledError` / `AgentAbortedError`) only so tracers written before `status` existed keep flagging it. `toM4trixTracer` records it as a `cancelled` trace. The optional `onUsage({ runId, contextId, agentId, tool?, usage, runUsage, scope? })` hook receives every `reportUsage()` call; `toM4trixTracer` records each as a finished `llm` run under the reporting agent, so it counts toward the trace's tokens and cost (report a call either this way or through a traced LLM span, not both). Agents receive a `tracing` scope in `.logic()`:

```ts
import { AgentNetwork } from '@m4trix/core/matrix';
import { Tracer, TraceStore, toM4trixTracer } from '@m4trix/tracing';

const tracer = Tracer.from(traceStore);

const network = AgentNetwork.setup(
  ({ registerAgent }) => {
    // wire agents and channels
  },
  {
    consoleTracing: true, // opt-in stdout spans + network trace logs
    networkTracer: toM4trixTracer(tracer), // TraceStore / trace-viewer
  },
);

const api = network.expose(
  registerSSEStream({ channel: 'client' }),
);

const agent = AgentFactory.run()
  .listensTo([messageEvent])
  .logic(async ({ tracing }) => {
    const llm = tracing.startRun('llm', 'gpt-4o', { prompt: 'hello' });
    await llm.end({ text: 'hi' });
  })
  .produce({});
```
