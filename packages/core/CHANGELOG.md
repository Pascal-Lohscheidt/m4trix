# Changelog

All notable changes to `@m4trix/core`. The full release notes, with every feature, are in the [docs changelog](https://docs.m4trix.dev/project/changelog).

## Unreleased (0.18.0)

0.18.0 makes runs explicit (they end exactly once, within limits), validates everything that crosses the network's boundaries, keeps history per user in a pluggable store, and trims the public API to what is meant to be used. Most apps need the migration notes under **Breaking changes**; each one says what to change.

### Breaking changes

- **Runs end, and their streams close.** A run ends exactly once with `m4trix:run.completed`, `m4trix:run.failed` or `m4trix:run.cancelled`, and an exposed stream closes after that event instead of staying open until the client leaves. An agent that throws now fails its run (`onAgentError: 'fail'`, the default) and aborts the run's other agents.
  _Migrate:_ declare what finishes a run with `endsOn(event, when?)` in `AgentNetwork.setup()`, or call `complete()` from agent logic; otherwise a run fails after `idleTimeout` (60 seconds without events) or at `maxDuration` (10 minutes). Pass `onAgentError: 'continue'` to keep the old "log and go on" behavior (it publishes `m4trix:agent.error`). Event names starting with `m4trix:` are reserved.

- **Runs have default limits.** A run fails (`kind: 'limit-exceeded'`) when an event is more than 25 hops from the start event (`maxDepth`) or the run publishes more than 1000 durable events (`maxEvents`). Emits get `meta.causationId` = the trigger's `eventId` and `meta.ts` = publish time (they used to copy the trigger's).
  _Migrate:_ raise the limits, or pass `Infinity`, in the setup options, `network.run()` or `registerSSEStream()`.

- **History is read on demand: `ctx.history`.** `runEvents` and `contextEvents` are gone from agent logic and from `EventAggregator` callbacks, as are `EventPlane.getRunEvents` / `getContextEvents`.
  _Migrate:_ `await history.run()` for the run's durable events; `await history.context({ limit, before })` for a page `{ events, cursor }` of the conversation (oldest first; pass `cursor` as `before` for older events). Outside an agent: `plane.history({ runId, contextId, principalId })`.

- **`AgentNetworkStore` is async and keyed by tenant.** The interface is `append(key, event)`, `readRun(key, runId)`, `readContext(key, { limit, before })` and optional `deleteContext(key)`, with `key = { namespace, contextId }`. `storeEvent`, `getEvents`, `getContextEvents`, `getFullStore`, `persist` and `load` are removed. Stored events carry `channels`; transient events are never stored. The in-memory store now expires conversations (30 minutes) and keeps at most 1000.
  _Migrate:_ rewrite custom stores against the new interface, persist `channels`, scope every read and write by `namespace` and `contextId`, and check the result with `runStoreContract` from `@m4trix/core/testing`. Pass the store as `AgentNetwork.setup(cb, { store })`; tune the default with `createInMemoryNetworkStore({ ttl, maxContexts })`.

- **`auth` returns a principal.** `AuthResult` is `{ allowed: true; principal?: { id, ...claims } } | { allowed: false; status?; message? }`. History is stored and read per `(principal, contextId)`; events of another principal's run are refused, and reusing another principal's `runId` is a 403. Proxy `publish` / `withMeta` / `publishInbound` ignore `meta.principalId`.
  _Migrate:_ return `{ allowed: true, principal: { id: user.id } }` from `auth` (without a principal every request shares one anonymous namespace, as before), and pass `{ principal }` explicitly to proxy publishes.

- **Tools reject with typed errors.** `Tool.of()` throws `ToolDefinitionError` for names outside `^[a-zA-Z0-9_-]{1,64}$`, and `define()` for input schemas that are not objects or cannot become JSON Schema. `execute` rejects with `ToolInputError`, `ToolExecutionError` (the tool's error is its `cause`), `ToolOutputError` or `ToolTimeoutError` instead of raw `ParseError`s, fiber failures or the tool's own error.
  _Migrate:_ catch the new error classes (or use `executeForModel()` / `toToolModelError()` to hand the error back to the model); read your own error from `error.cause`.

- **Emits, params and requests are validated.** An agent or tool may only emit events declared in its `.emits([...])`, with a valid payload, to a channel that accepts it; anything else throws `EmitValidationError` and fails the invocation (run failure `kind: 'invalid-emit'`). Agents without `.emits()` may emit nothing. Channels with `.events([...])` refuse other events. `AgentNetwork.setup()` throws `NetworkWiringError` for contradictory wiring. `.produce(params)` throws `AgentParamsError`. `expose()` answers malformed JSON and invalid payloads with a 400 before any run starts; with several `triggerEvents` the body must be `{ name, payload }`.
  _Migrate:_ add `.emits([...])` to every agent and tool that emits (`{ reply: true }` for events that only answer an `emitAndAwait`), declare channel events where you rely on them, and send `{ name, payload }` when a route has several trigger events.

- **Tracer hooks get a status.** `NetworkTracer.onRunEnd` and `onAgentInvokeEnd` receive a third argument `{ status: 'ok' | 'error' | 'cancelled' }`; a cancelled run is no longer an error. `RunErrorKind` gained `'run-unavailable'` and `'stream-error'`.
  _Migrate:_ custom tracers should check `options.status` before `error` (for `cancelled`, `error` is still set); exhaustive `switch`es over `error.kind` need the new cases.

- **SSE responses carry ids.** Responses start with an `id:` line and carry `id:` on durable events, plus `: ping` heartbeat comments.
  _Migrate:_ nothing with `EventSource`; hand-written SSE parsers must accept `id:` and `:` comment lines.

- **A dropped stream keeps its run for 30 seconds.** `reconnectWindow` defaults to `'30 seconds'`: a run whose client disconnected keeps going that long so a reconnect (`Last-Event-ID`) continues it live, then it is cancelled.
  _Migrate:_ pass `registerSSEStream({ reconnectWindow: 0 })` to cancel at once, as before.

- **Renamed (no aliases).** `DepedencyLayer` → `DependencyLayer`, and with it `DependencyLayerDef`, `DependencyLayerInstance`, `DependencyLayerValue`, `DependencyLayerInstanceTypeId`, `isDependencyLayerInstance`. A layer definition's `_tag` is `'DependencyLayerDef'` (was `'SkillDependencyDef'`); brand symbols use the `m4trix/` namespace (`Symbol.for('m4trix/DependencyLayerInstance')`, `Symbol.for('m4trix/Done')`).
  _Migrate:_ search and replace `Depedency` → `Dependency`; update code that compares `_tag` or the symbol keys.

- **Removed APIs.**
  - The spawner: `ctx.spawner`, `SpawnerBuilder`, `SpawnFn`, `SpawnCallbackContext`, `network.getSpawnerRegistrations()` and the wiring code `spawner-listen-not-accepted`. _Migrate:_ register agents at setup and vary their behavior per tenant through `principal` and dependency layers.
  - `Proxy.kafka()` and `Proxy.socketIo()`. _Migrate:_ `proxy.custom(kind, config, direction)` or `defineProxyKind(kind)` with `registerCustomProxy`; Kafka and Socket.IO bridges are planned on top of `EventTransport`.
  - The socket.io helpers (`SocketIoFactory`, `SocketEventName`, `BaseMessage`, `TextMessage`, `VoiceMessage`, `Message`, `Role`), the unused LLM, prompt and message-transform helpers, and `Channel.of` / `ChannelDef`.
  - Internal helpers that were exported by accident: `assertLayersProvided`, `assertUniqueLayerNames`, `assertDependencyMatch`, `toLayerArray`, `mergeDependencyLayers`, `toToolArray`, `channelAcceptsEvent`, `channelHasProxy`, `createInboundPublisher`, `createProxyExposeContext`, `createInteractiveStream` (custom proxies still get `ctx.createInteractiveStream`), `resolveChannelsForProxyKind`, `guardNetworkTracer`, `tracerFailureLogger`, `traceEndStatus`, `pickRunLimits`, `resolveRunLimits`, `runEndEnvelope`, `runUnavailableEnvelope`, `streamFailedEnvelope`, `outcomeError`, `outcomeTraceStatus`, `withRunUsage`, `limitExceededOutcome`, `agentFailureOutcome`, `serializeAgentError`, `serializeError`, `storeErrorOutcome`.

- **Packaging.** `effect` is a peer dependency (`^3.20.0`) and no longer installed with the package; Node.js 20+ is required.
  _Migrate:_ `pnpm add effect` next to `@m4trix/core`.

### Features

- **Resumable, hardened SSE**: `Last-Event-ID` (or `?lastEventId=`) resumes a run from the store and continues it live; `ExposeRunNotFoundError` (404) for unknown runs; heartbeats, back-pressure on Express, GET payloads via `?payload=`, safe payload serialization.
- **Run controls**: `endsOn`, `complete()`, `fail()`, `signal` in agents, tools and skills; `idleTimeout`, `maxDuration`; `maxDepth`, `maxEvents`, `maxTokens`, `maxCostUsd` budgets; `reportUsage()` summed per run and model.
- **Concurrency**: per-run mailboxes and ordering, runs in parallel, `.concurrency(n)` per agent, transient events (`{ transient: true }`) that slide instead of blocking, also when only a tool emits them.
- **Stores, tenancy and transport**: pluggable `AgentNetworkStore`, per-principal history, `EventTransport` seam with `createInMemoryTransport()`, `runStoreContract` / `runTransportContract` in `@m4trix/core/testing`.
- **Context folds**: a typed, incremental, budget-aware view of a conversation instead of re-reading `history.context()` on every step. `ContextFold.of(name, { version })` folds events with pure handlers (`.over()`, `.initial()`, `.on()`) and restarts from the newest `.checkpointOn()` event (compaction); `SegmentedFold` keeps atomic segments (a model step with all its tool results); `fold.view(name, { budget, strategies })` trims a fold to a token budget with `ContextStrategy.elide()` / `ContextStrategy.dropOldest()` (or your own `ContextStrategy`) and reports `{ tokens, overBudget, dropped }`; `approxTokenCount()` is the default counter. Agents and aggregators declare them with `.folds([...])` and read `await ctx.folds.<name>()`: lazy, folded incrementally and cached per context (or run) on the event plane, bounded by the `foldCache` setup option (`{ maxEntries, ttl }`). The wiring check warns with `fold-event-unpublished` when nothing publishes a folded event; the `m4trix.fold.read.events` metric reports each read (`cold` / `warm` / `reset`).
- **History reads**: `history.context({ names, after })` filters by event name and reads forward from a page's `head` cursor; `history.latest(names)` returns the newest matching event and a cursor (e.g. the latest checkpoint), backed by the optional `AgentNetworkStore.readLatest`. A page read `after` a cursor of a deleted or expired context comes back from the start of the current history with `reset: true`.
  _Custom stores:_ `names`, `after` (rejected together with `before`), `head` on every non-empty page and `reset` for stale `after` cursors are required behaviour of `readContext`, checked by `runStoreContract`; `readLatest` is optional.
- **Tools for LLM providers**: JSON Schema from Effect schemas, `toOpenAI()`, `toAnthropic()`, `toAiSdk()`, `executeForModel()`, `.timeout()`, `.retry()`, a trace span per tool call.
- **Observability**: `logger` and `onMetric` setup options, tracer `onUsage` hook, `network.validate()` wiring check.
- **Explicit public API**: every export is listed by name and recorded in an API report checked in CI; `Envelope` and `DEFAULT_RECONNECT_WINDOW` are exported.
- **Edge runtimes**: no Node built-ins (Vercel Edge, Cloudflare Workers, Deno, Bun), checked in CI; side-effect free (`"sideEffects": false`); CommonJS consumers get their own `.d.cts` types.
- **`NextEndpoint.from(api)` / `ExpressEndpoint.from(api)`** work without options: each request gets fresh run and conversation ids unless `requestToRunId` / `requestToContextId` say otherwise.
