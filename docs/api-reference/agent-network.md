---
title: "AgentNetwork"
---

The `AgentNetwork` orchestrates agents, channels, and the event plane. Use `AgentNetwork.setup()` to wire everything together.

## Setup

```ts
const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator, endsOn }) => {
    // ...
  },
);
```

## Setup Context

### `mainChannel(name)`

Creates and designates the **main channel**. Start events are published here when the network is exposed as an API. Every network should have exactly one main channel.

```ts
const main = mainChannel('main');
```

### `createChannel(name)`

Creates an additional named channel. Names must be kebab-case.

```ts
const client = createChannel('client');
const analytics = createChannel('analytics');
```

### `proxy`

Provides proxy factories: `proxy.sse()` (exposed with [`registerSSEStream`](io-adapters.md)) and `proxy.custom(kind, config?, direction?)` for your own kinds (see [`defineProxyKind`](io-adapters.md#custom-proxies)):

```ts
const client = createChannel('client').proxy(proxy.sse());
const events = createChannel('events').proxy(proxy.custom('queue', { topic: 'events' }));
```

Kafka and Socket.IO bridges are not built in; they are planned on top of [`EventTransport`](#event-transport).

### `registerAgent(agent)`

Registers an agent and returns a binding builder:

```ts
registerAgent(myAgent)
  .subscribe(main)
  .publishTo(client);
```

An agent can subscribe to and publish to multiple channels:

```ts
registerAgent(routerAgent)
  .subscribe(main)
  .subscribe(feedback)
  .publishTo(client)
  .publishTo(analytics);
```

### `endsOn(event, when?)`

Declares a **terminal event**: when it is published in a run (and `when` accepts it, if given), the run completes with `m4trix:run.completed`, its in-flight agents are aborted and its stream closes. `when` receives the typed envelope. Call `endsOn` once per terminal event.

```ts
endsOn(AnswerEvent);

// The user's message and the reply share an event: end on the reply only.
endsOn(MessageEvent, (event) => event.payload.role === 'assistant');
```

Terminal events live on the network because agents emit them, and because the event plane enforces them, they apply to `expose()`, custom proxies and `network.run()` alike. An agent can also end its run from logic with `complete()`. See [Run Lifecycle](io-adapters.md#run-lifecycle).

## Setup Options

The second argument of `AgentNetwork.setup()`:

| Option | Description |
|--------|-------------|
| `onAgentError` | `'fail'` (default): an agent that throws (including an invalid emit, `kind: 'invalid-emit'`) fails the run with `m4trix:run.failed` and aborts the run's other agents. `'continue'`: publish `m4trix:agent.error` and keep the run going |
| `logger` | Receives what the network reports without failing on it: wiring smells at setup, refused publishes, store and tracer failures, invalid usage reports, stream errors. `{ debug?, info?, warn, error? }` (each `(message, data?)`); `console`, pino and most leveled loggers fit. `error` falls back to `warn`; a throwing logger is ignored. Default: `console`. See [Logger](../guides/error-handling-observability.md#logger) |
| `onMetric` | `(metric: NetworkMetric) => void`: run durations and outcomes, agent invocation latencies, mailbox depths, events per run, store writes and usage, vendor-neutral. A throwing handler never breaks the network. See [Metrics](../guides/error-handling-observability.md#metrics) |
| `transport` | The [`EventTransport`](#event-transport) carrying channel events and `emitAndAwait` replies between the network's planes. Default: one in-memory transport per plane |
| `wiring` | Options of the [wiring check](#wiring-check): `{ ignore?: WiringWarningCode[] }` |
| `networkTracer` | Custom `NetworkTracer` for run, event and agent hooks |
| `consoleTracing` | Log runs, events and agent invocations to stdout. Off by default |
| `tracingLayer` | Effect layer for event plane spans |
| `store` | Where the network keeps event history (an [`AgentNetworkStore`](#event-history-and-stores)). Shared by every plane of the network. Default: `createInMemoryNetworkStore()` |
| `maxDepth` | Fail a run when an event would be more than this many hops from its start event (`meta.depth`), e.g. two agents triggering each other in a loop. Default `25` |
| `maxEvents` | Fail a run when it publishes more durable events than this, its start event included. Transient and `m4trix:*` events don't count. Default `1000` |
| `maxTokens` | Fail a run once its agents and tools reported more `totalTokens` than this with `reportUsage()`. Off by default |
| `maxCostUsd` | Fail a run once its reported `costUsd` exceeds this. Off by default |

```ts
const network = AgentNetwork.setup(
  ({ mainChannel, registerAgent }) => {
    // ...
  },
  { onAgentError: 'continue' },
);
```

Agents can always fail their run explicitly with `fail(error)`, whatever the policy.

The four run limits apply to every run of the network; `Infinity` disables one. Override them per plane with `network.run({ maxDepth })` or per exposed run with `registerSSEStream({ maxEvents })`. A run that exceeds one fails with `m4trix:run.failed`, `error.kind: 'limit-exceeded'` and the `limit` (`'depth' | 'events' | 'tokens' | 'cost'`) and its `max`; the event that would have exceeded `maxDepth` / `maxEvents` is not delivered. See [Run limits, usage and budgets](../guides/error-handling-observability.md#run-limits-usage-and-budgets).

## Wiring check

When the setup callback returns, `AgentNetwork.setup()` checks the network's wiring: which agents (and their tools) emit and listen to which events on which channels, against what the channels accept ([`.events()`](channel-api.md#events)). Contradictions throw a `NetworkWiringError` that lists all of them at once (`error.errors`); smells are logged through the `logger` option and do not stop the network.

| Code | Kind | Meaning |
|------|------|---------|
| `emit-not-accepted` | error | An agent declares an event in `.emits()` (its own or a tool's), but none of its `publishTo` channels accepts it |
| `listen-not-accepted` | error | An agent listens to an event, but none of the channels it subscribes to accepts it |
| `unconsumed-event` | warning | An emitted event reaches no agent listening to it and no proxy that streams it out on the channels it lands on (and does not end the run). Expected for `emitAndAwait` replies, which the waiting agent receives without listening, and for channels you read yourself with `plane.subscribe` |
| `agent-publishes-nowhere` | warning | An agent emits events but has no `publishTo` channel |
| `agent-not-subscribed` | warning | An agent is not subscribed to any channel, so it is never invoked |
| `agent-unreachable` | warning | An agent subscribes to channels where none of the events it listens to can arrive: no agent publishes them there, and the channel is not fed from outside (the main channel, a receiving proxy, or a channel that declares the event) |
| `terminal-event-not-emitted` | warning | `endsOn(event)` names an event no agent emits; runs only end on it when it is published from outside |

Two ways to silence a warning you expect:

- **Reply events.** Declare events that only answer an `emitAndAwait` with `{ reply: true }`, on agents and tools alike. The waiting agent receives them without listening, so they are not reported as unconsumed (they must still be accepted by a channel the agent publishes to):

  ```ts
  AgentFactory.run()
    .listensTo([TaskRequested])
    .emits([Progress]) // listened to or streamed: checked as usual
    .emits([TaskCompleted], { reply: true }); // only answers the requester's emitAndAwait
  Tool.of({ name: 'approve', description: '…' }).emits([Approved], { reply: true });
  ```

- **`wiring.ignore`** leaves whole warning codes out of the check, at setup and in `network.validate()`, e.g. when you read channels yourself with `plane.subscribe` (errors cannot be ignored):

  ```ts
  AgentNetwork.setup(setup, { wiring: { ignore: ['unconsumed-event'] } });
  ```

Run the same check yourself, e.g. to assert a clean network in a test:

```ts
const { errors, warnings } = network.validate(); // ReadonlyArray<{ code, message, agentId?, event?, channels? }>
expect(warnings).toEqual([]);
```

Each issue has a `code`, a readable `message` and, where they apply, the `agentId`, `event` and `channels` concerned. `network.validate()` never throws; it also reports problems introduced after setup (e.g. `.events()` called on a channel later).

## Running the Network

### HTTP API (recommended)

```ts
const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [requestEvent],
  }),
);
```

See [IO + Adapters](io-adapters.md).

### Programmatic Run

```ts
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      // Returns once every agent is subscribed: events published next are not missed.
      const plane = yield* network.run();
      // publish events, wait for results...
    }),
  ),
);
```

### Concurrency model

- **Serial per run, parallel across runs.** Each agent has one mailbox per run, merged across all channels it subscribes to. It handles a run's events one at a time, in publish order; a slow invocation for one run never delays another run. Cap an agent's invocations across runs with [`.concurrency(n)`](agent-factory.md#concurrencylimit).
- **Back-pressure per run.** Mailboxes hold `capacity` events (`network.run({ capacity })`, default 16). When one is full, outside publishers of that run (`plane.publish`, inbound proxy events) wait; other runs are unaffected. Events the run's own agents emit are queued past the bound instead, so one busy agent cannot hold back the rest of the run, e.g. the reply it is waiting for with `emitAndAwait`; the run's `maxEvents` limit bounds that growth. [Transient](agent-network-event.md#transient-events) events replace the oldest buffered transient event instead of waiting.
- **No self-replies.** Since an agent handles a run's events one at a time, it cannot `emitAndAwait` a reply that it would produce itself (in a later invocation of the same run); that wait only ends at its timeout. Replies from other agents are fine.
- **Ordered emits.** Everything an invocation emits (including `emitAndAwait` requests and `complete()`) is published in call order, inside the network's scope.
- **Released on end.** When a run ends, its queued events are dropped and its mailboxes and fibers are released; the plane only remembers the outcome of recently ended runs.

## Event history and stores

Every durable event a run publishes is written to the network's store **before** it is delivered, so an agent always finds its trigger (and everything earlier) in history. Agents and aggregators read it on demand:

```ts
.logic(async ({ triggerEvent, history, emit }) => {
  const runEvents = await history.run(); // this run so far, in publish order, trigger included
  const page = await history.context({ limit: 50 }); // newest 50 of the conversation, oldest first
  const older = page.cursor ? await history.context({ limit: 50, before: page.cursor }) : undefined;
})
```

- `history.run()` returns the run's durable events. `history.context({ limit?, before? })` returns `{ events, cursor? }`: the newest `limit` events of the context across its runs (all of them without `limit`), oldest first. Pass `cursor` as `before` for the page of older events; it is absent once the first event is reached.
- History is scoped to the run's principal (see [Auth + Multi-Tenant](../guides/auth-multitenant.md)): `(namespace, contextId)`, never `contextId` alone.
- [Transient](agent-network-event.md#transient-events) events are streamed and traced but never stored, so they are never in history.
- `EventAggregator` callbacks (`emitWhen`, `mapToEmit`) get the same `history`. Outside a network (`agent.invoke()`), history is empty. Code holding a plane can read it with `plane.history({ runId, contextId, principalId? })`.

### Write failures and ordering

A store write that fails is retried (3 attempts in total, 10 ms then 20 ms apart). If it still fails, the event is **not** delivered (history never misses an event an agent saw) and the run fails with `m4trix:run.failed`, `error.kind: 'store-error'` (a client-safe `NetworkStoreError`; the store's own error is its `cause`, for tracers only). The run-end event itself is still streamed when the store is down. Writes of one run are applied one after another in publish order, whatever the store's latency; runs and contexts write concurrently.

### The in-memory store

The default store keeps history in the process: lost on restart and not shared between instances. It is bounded:

```ts
import { AgentNetwork, createInMemoryNetworkStore } from '@m4trix/core/matrix';

const network = AgentNetwork.setup(setup, {
  store: createInMemoryNetworkStore({
    ttl: '30 minutes', // drop a context this long after its last event (reads don't extend it)
    maxContexts: 1000, // beyond this, evict the least recently used context
  }),
});
```

Both are the defaults; `Infinity` disables either. Expiry is lazy (on read, or when another context is written), so the store runs no timers. Pass `clock` (anything with `unsafeCurrentTimeMillis()`, such as an Effect `Clock`) to control time in tests. Use a persistent store when history must survive restarts or be shared across instances.

### Writing a store adapter

A store implements `AgentNetworkStore`:

```ts
interface AgentNetworkStore {
  append(key: AgentNetworkStoreKey, event: StoredEvent): Promise<void>;
  readRun(key: AgentNetworkStoreKey, runId: string): Promise<readonly StoredEvent[]>;
  readContext(key: AgentNetworkStoreKey, options?: { limit?: number; before?: string }): Promise<EventPage>;
  deleteContext?(key: AgentNetworkStoreKey): Promise<void>;
}
type AgentNetworkStoreKey = { readonly namespace: string; readonly contextId: string };
type EventPage = { readonly events: readonly StoredEvent[]; readonly cursor?: string };
```

- **`append`** resolves once the event is durable and rejects on failure (the runtime retries). The runtime never has two appends of one run in flight, so appending in call order keeps each run in order.
- **`readRun`** returns one run's events in append order.
- **`readContext`** returns the newest `limit` events (before the `before` cursor) in append order, with a `cursor` for the older page. Cursors are opaque strings of your choosing (e.g. a sequence number) and must stay valid while newer events are appended.
- **`deleteContext`** (optional) removes one context of one namespace, e.g. when a user clears a chat. Call it yourself through `network.getStore()`.
- **Keys.** Scope every read and write by both `namespace` and `contextId`. Encode them unambiguously when you build one backend key (`JSON.stringify([namespace, contextId])`, or two columns): `principal:a` + `b:c` must not collide with `principal:a:b` + `c`. Events are JSON-compatible (`name`, `meta`, `payload`, and `channels`).
- **Keep `channels`.** The runtime stores each event with the channels it was published to (`StoredEvent.channels`). [Resumed SSE streams](io-adapters.md#resuming-a-stream-last-event-id) replay only their own channel's events with it; without it they fall back to a guess (lifecycle events, and agents' events the channel accepts).
- The store's owner manages its connection: core never opens or closes it.

Check an adapter against the contract suite from `@m4trix/core/testing`. It does not depend on a test framework: pass your runner's `describe`, `it` and `expect` (only `toEqual` is used):

```ts
// redis-network-store.spec.ts
import { describe, expect, it } from 'vitest';
import { runStoreContract } from '@m4trix/core/testing';
import { createRedisNetworkStore } from './redis-network-store';

runStoreContract({ describe, it, expect }, () => createRedisNetworkStore(redis));
```

It covers append and read order, keeping `channels`, run vs context reads, paging cursors, namespace and context isolation, `deleteContext` (when implemented) and concurrent appends to different contexts. Every case uses fresh keys, so one database may serve all cases.

## Event transport

The event plane hands channel events to their subscribers (SSE streams, `plane.subscribe`) and `emitAndAwait` replies to their waiters through an `EventTransport`. Everything per run stays in the plane: mailboxes, ordering, back-pressure, limits, ownership and run ends.

```ts
type EventTransport = {
  // To every subscriber of each channel, and to every reply waiter the event matches.
  publish(channels: ReadonlyArray<string>, envelope: Envelope): Effect.Effect<void>;
  // Calls `handler` for each event published to `channel` from now on, until the scope closes.
  // The handler's completion acknowledges the event.
  subscribe(channel: string, handler: (envelope: Envelope) => Effect.Effect<void>): Effect.Effect<void, never, Scope.Scope>;
  // Waits for the first later event (not the request itself, by `eventId`) that `match` accepts.
  expectReply(request: Envelope, match: (reply: Envelope) => boolean): Effect.Effect<Effect.Effect<Envelope>, never, Scope.Scope>;
};
```

The default is a fresh `createInMemoryTransport()` per plane, which keeps everything in the process. Pass one instance as the `transport` setup option to connect all planes of the network in the process (e.g. a stream on one `expose()` request sees events published on another plane). A transport backed by Redis Streams, NATS or Kafka would connect several instances; see [Deployment](../guides/deployment.md#scaling-out). Check an implementation with `runTransportContract({ describe, it, expect }, createTransport)` from `@m4trix/core/testing`, like a store.

`plane.publishAndAwait` and `emitAndAwait` fail with `PublishAndAwaitTimeoutError` (`_tag`, `timeout`) when no reply arrives in time (default 30 seconds).

## Accessors

```ts
network.getChannels();             // Map<ChannelName, ConfiguredChannel>
network.getMainChannel();          // ConfiguredChannel | undefined
network.getAgentRegistrations();   // Map<string, AgentRegistration>
network.getTerminalEvents();       // ReadonlyArray<RunTerminalEvent> (from endsOn)
network.getAgentErrorPolicy();     // 'fail' | 'continue'
network.getRunLimits();            // { maxDepth, maxEvents, maxTokens, maxCostUsd }, defaults filled in
network.getStore();                // AgentNetworkStore (the `store` option or the in-memory default)
network.getTransport();            // EventTransport | undefined (the `transport` option)
network.getLogger();               // the `logger` option (or console), with every level
network.getWiringOptions();        // the `wiring` option
network.validate();                // { errors, warnings } of the wiring check
```

## See Also

- [Networks (Concepts)](../concepts/networks.md)
- [Patterns](../guides/patterns.md)
- [IO + Adapters](io-adapters.md)
