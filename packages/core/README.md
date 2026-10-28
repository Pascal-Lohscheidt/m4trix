[![CircleCI](https://dl.circleci.com/status-badge/img/gh/Pascal-Lohscheidt/m4trix/tree/main.svg?style=svg)](https://dl.circleci.com/status-badge/redirect/gh/Pascal-Lohscheidt/m4trix/tree/main)
[![npm version](https://img.shields.io/npm/v/@m4trix%2Fcore)](https://www.npmjs.com/package/@m4trix/core)
[![npm downloads](https://img.shields.io/npm/dm/@m4trix%2Fcore)](https://www.npmjs.com/package/@m4trix/core)
[![license](https://img.shields.io/npm/l/@m4trix%2Fcore)](https://www.npmjs.com/package/@m4trix/core)

# @m4trix/core

Typed agent networks for TypeScript. Define events with schemas, wire agents to channels, give them tools and injected dependencies, and stream every run to the client over SSE.

- **Agent networks** — agents subscribe to channels and publish to channels; the event plane delivers each run's events in order, with back-pressure, and runs different runs in parallel.
- **Typed events, tools and layers** — events are [Effect](https://effect.website/) schemas, checked when they are published. Agents declare what they listen to and emit (`.listensTo()`, `.emits()`), and the wiring is checked at setup. Tools have input and output schemas, timeouts and retries, and convert to OpenAI, Anthropic and AI SDK tool definitions. Model clients, databases and other services are injected as dependency layers: core itself depends on nothing but `effect`.
- **Context folds** — `ContextFold` / `SegmentedFold` turn a conversation's events into typed state, folded incrementally and cached; views (`ContextView.of()`, `ContextStrategy`) trim it to a model's context window, at the budget of each call, without splitting a tool call from its result, and an agent compacts it with `await folds.conversation.compact(...)` without losing events. Agents read them with `.folds([...])` → `await folds.conversation()`.
- **Streaming** — `network.expose()` turns a network into an SSE endpoint for Next.js (`NextEndpoint`) or Express (`ExpressEndpoint`). A run ends exactly once (`endsOn`, `complete()`, timeouts, limits) and its stream closes after the run-end event. Streams resume after a dropped connection (`Last-Event-ID`), and transient events (token deltas, progress) are streamed but never stored.
- **For production** — per-user history in a pluggable store, run limits and token or cost budgets, a tracer hook (see [`@m4trix/tracing`](https://www.npmjs.com/package/@m4trix/tracing)), metrics and a logger.

Runs on Node.js 20+ and on Edge runtimes (Vercel Edge, Cloudflare Workers, Deno, Bun): no Node built-ins.

## Install

```bash
pnpm add @m4trix/core effect
```

`effect` (`^3.20`) is a peer dependency: your schemas and m4trix share one copy.

## Quick Start

A Next.js route that streams an answer token by token, then ends the run:

```ts
// app/api/chat/route.ts
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  DependencyLayer,
  NextEndpoint,
  registerSSEStream,
  S,
} from '@m4trix/core';

// 1. Events: typed payloads, validated when they are published.
const Question = AgentNetworkEvent.of('question', S.Struct({ text: S.String }));
const Token = AgentNetworkEvent.of('token', S.Struct({ delta: S.String }), { transient: true });
const Answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));

// 2. A dependency layer: the model client is injected, not imported by the agent.
const Llm = DependencyLayer.of({
  name: 'Llm',
  config: S.Struct({ model: S.String }),
}).define<{ stream: (prompt: string, signal: AbortSignal) => AsyncIterable<string> }>();

// 3. An agent: what it listens to, what it may emit (anything else throws), and its logic.
const assistant = AgentFactory.run()
  .listensTo([Question])
  .emits([Token, Answer])
  .dependsOn(Llm)
  .logic(async ({ triggerEvent, emit, layers, signal }) => {
    let text = '';
    for await (const delta of layers.Llm.stream(triggerEvent.payload.text, signal)) {
      text += delta;
      emit(Token.make({ delta }));
    }
    emit(Answer.make({ text }));
  })
  .produce({});

// 4. The network: channels, who subscribes and publishes where, and when a run is done.
const network = AgentNetwork.dependsOn(Llm).setup(
  ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(assistant).subscribe(mainChannel).publishTo(client);
    endsOn(Answer); // the run, and the response, end with the answer
  },
);

// 5. Expose it: a POST with `{ "text": "..." }` starts a run and streams the client channel.
async function* fakeModel(prompt: string): AsyncIterable<string> {
  for (const word of `You asked: ${prompt}`.split(' ')) yield `${word} `;
}

const api = network.expose(
  registerSSEStream({
    channel: 'client',
    triggerEvents: [Question],
    layers: {
      // Plug in your model client here.
      Llm: Llm.make({ config: { model: 'demo' }, stream: (prompt) => fakeModel(prompt) }),
    },
  }),
);

const handler = NextEndpoint.from(api).handler();
export const POST = handler;
export const GET = handler; // for EventSource: ?payload=<URL-encoded JSON>
```

The response is an SSE stream of `token` events, the `answer`, and `m4trix:run.completed`. Invalid payloads get a 400 before anything runs; an agent that throws ends the run with `m4trix:run.failed`.

## Documentation

- [Getting started](https://m4trix.dev/docs/getting-started/install) — install, hello world, how-to recipes
- [Concepts](https://m4trix.dev/docs/concepts/events) — events, channels, agents, networks, [context (folds and views)](https://m4trix.dev/docs/concepts/context), streaming
- [Guides](https://m4trix.dev/docs/guides/nextjs) — Next.js, Express, auth and multi-tenancy, error handling and observability, testing, deployment
- [API reference](https://m4trix.dev/docs/api-reference/agent-network) — `AgentFactory`, `AgentNetwork`, events, channels, IO adapters
- [Changelog](./CHANGELOG.md) — breaking changes with migration notes

Entry points: `@m4trix/core` (everything), `@m4trix/core/matrix` (the same exports, for existing imports) and `@m4trix/core/testing` (`runStoreContract` and `runTransportContract` to check your own store or transport).

## Contributing

The package lives in the [m4trix monorepo](https://github.com/Pascal-Lohscheidt/m4trix) (pnpm workspace) under `packages/core`.

```bash
pnpm --filter @m4trix/core build        # tsup: ESM, CJS and types
pnpm --filter @m4trix/core typecheck    # sources and specs
pnpm exec vitest run packages/core      # tests
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(matrix): ...`, `fix(matrix): ...`); the changelog is generated from them.

### API report

The public API is recorded in [`api/`](./api) (`core.api.md`, `core-matrix.api.md`, `core-testing.api.md`), generated by [API Extractor](https://api-extractor.com/) from the built type declarations. CI runs `api:check`, which fails when an export or a signature changed without the report changing with it.

When you change the public API on purpose:

```bash
pnpm --filter @m4trix/core build
pnpm --filter @m4trix/core api:update   # rewrites api/*.api.md
```

Review the diff of `api/*.api.md` and commit it with your change; a breaking change also needs a changelog entry with migration notes. New exports go into `src/matrix/index.ts` and `src/index.ts` by name (there are no `export *`): keep internal helpers out of them.

CI also runs `pnpm --filter @m4trix/core check:runtime`, which fails when the built bundle imports a Node built-in (core must keep running on Edge runtimes).

## License

MIT

---

Created by the makers of [Stepsailor](https://stepsailor.com) (Pascal Lohscheidt)
