# Docs system: concepts, code and graphics that can't drift

A plan for turning the m4trix docs into something people learn from, not just look things up
in. It covers what the best docs in this space do, what ours lack today, and a system of page
templates and components that keeps prose, code and graphics in sync with the library.

## What the best docs in this space do

| Library | What works | What we take |
| --- | --- | --- |
| **LangGraph** | Concepts, how-tos, tutorials and reference are separate sections. Graph diagrams are drawn from the compiled graph itself (`drawMermaid()`), so they match the code. | Separate sections by purpose. Topology diagrams generated from a real `AgentNetwork`. |
| **Inngest** | "Walk through a run": a numbered execution trace whose step names are the names in the code (`"parse-csv"` …), plus diagrams of checkpoints and replays. | A walkthrough under every concept, keyed to the event and agent names in its snippet. |
| **Temporal** | One concept per page, opening with a definition ("What is a Workflow Execution?"), one captioned SVG per mechanism, a status/lifecycle diagram and glossary links for every term. | Definition-first concept pages, captioned figures, a lifecycle diagram for runs, glossary hovers. |
| **Stripe** | Two-column walkthroughs: each prose step highlights the lines it talks about in a code panel, ending in a complete downloadable sample. | A code walkthrough component for tutorials; every tutorial ends in a runnable `examples/` project. |
| **Effect, tRPC, Zod** | Twoslash code: hover a variable to see its inferred type, `// ^?` shows types inline. | Type inference is m4trix's pitch (`triggerEvent`, `emit`, `layers`). Show it, don't claim it. |
| **Vercel AI SDK** | A "Foundations" section for newcomers, framework tabs (Next.js / Node / …) on every integration snippet. | A mental-model page up front; Next.js / Express tabs on every exposure snippet. |
| **Mastra** | Short pages ending in a goal → page table ("Add tools", "Add memory", …). | A "What next" table on every concept page. |

## Where our docs are today

- **Navigation mirrors files, not questions.** Titles like "Events (Type System + Schema)" and
  "IO + Adapters (NextEndpoint, Express, etc.)" describe content instead of what a reader wants.
- **One 824-line how-to page** holds 16 unrelated tasks (streaming, tools, auth, history,
  dependency layers, ending runs …). None of them can be linked, ranked in search or kept short.
- **Concepts the code has but the docs barely explain.** Skills, tools, dependency layers, event
  aggregators and `emitAndAwait`, the run lifecycle (`endsOn`, `complete()`, limits,
  cancellation), history and stores, transport, principals and tenancy, and usage are spread
  across the API reference, how-to and changelog instead of having concept pages.
- **Thin pages.** `whats-happening`, `examples/rag-tools` and `examples/multi-agent-workflow`
  have little or no code.
- **Snippets are hand-written in MDX.** Nothing checks they still compile. Core just shipped
  several breaking changes (run lifecycle, tool errors, run limits), so drift is likely already
  happening.
- **Three graphics in total.** They are good, but nothing ties them to the code they illustrate.

## The system: three guarantees

### 1. Every snippet compiles

- Snippets live as real files in `website/content/snippets/**.ts`, typechecked in CI against the
  workspace packages. Named regions (`// #region wiring`) select the part a page shows.
- MDX includes them at build time:
  `<Snippet file="concepts/fan-out.ts" region="wiring" highlight="3-5" />`.
- Twoslash (`@shikijs/twoslash`) renders inferred types on hover and inline with `// ^?`, e.g.
  the type of `triggerEvent` inside `.logic()`.
- Snippet files are runnable, so the same code feeds the recorder below.

### 2. Every runtime graphic comes from a real run

The landing page already does this: `website/scripts/record-agent-run.mts` runs a real network
with mocked model calls and records every event and invocation, and the landing page replays the
recording. Generalise that:

- **Recorder.** Any snippet that exports `network` and a `scenario` gets run with mocked models
  and writes `runs/<id>.json`: events, channels, publishing agent, causality, timing and
  invocations.
- **Live in the docs: `<RunPlayer run="fan-out" />`.** It draws the network, channels and agents
  in the shared visual language and plays or scrubs the run. Clicking an event shows its
  envelope. The snippet line that emitted the current event is highlighted, which is what
  `AgentRunReplay` already does on the landing page.
- **Static for everywhere else.** `docs-visual-gen` renders the same recording to GIF / PNG for
  READMEs, npm, social cards and the `.md` / `llms.txt` output.
- **Topology from code: `<NetworkDiagram network="…" />`.** Generated from the network itself,
  the same introspection behind `network.validate()` (`validateWiring`), just as LangGraph draws
  from the compiled graph. The `.md` output gets a text equivalent, so LLMs see the structure too.
- **Text walkthrough from the recording.** "1. `user-message` is published on `main` …
  3. `agentA`, `agentB` and `agentC` each receive a copy …", generated from the run so the names
  always match the code (the Inngest pattern).

### 3. One visual language

- Move `docs-visual-gen/src/lib` into a private workspace package (`@m4trix/docs-ui`) used by both
  the website and the renderer. Redesigning `Agent` then updates landing graphics, live docs
  players and exported GIFs together.
- Fixed meanings, shown once in a small legend on the mental-model page:
  - **Agent:** blue chip with a lightning icon.
  - **Event:** violet pill with an envelope icon.
  - **Channel:** tinted, dashed region. An agent where two channels overlap subscribes to one and
    publishes to the other.
  - **`expose()` and proxies:** ports on the network border.
  - **Run end:** neutral pill with a check icon.
- Dark and light variants from the same tokens as the website.

## Page templates

Diátaxis split: **Learn** (tutorials), **Understand** (concepts), **Build** (how-tos),
**Reference** (generated).

### Concept page

1. **Definition:** one sentence. "A channel is a named stream of events that agents subscribe
   to and publish into."
2. **Mental model:** one static figure (`<NetworkDiagram>` or a docs-visual-gen scene) with a
   caption.
3. **Smallest working code:** a `<Snippet>` with twoslash types, under about 20 lines.
4. **How it behaves:** a `<RunPlayer>` of that snippet with the generated numbered walkthrough
   under it.
5. **Rules and guarantees:** delivery, ordering, validation, what happens on errors. Short
   bullets and links to tests or reference.
6. **Common mistakes:** a warning callout drawn from FAQ entries and the wiring check's warnings.
7. **What next:** a goal → page table (how-tos and API reference).

### How-to page

A task title ("Stream LLM tokens to the browser"), prerequisites, numbered steps, final code
with Next.js / Express tabs, the expected output, and troubleshooting. One task per page. The
current `how-to.mdx` splits into about 16 of these.

### Tutorial

A Stripe-style `<CodeWalkthrough>`: prose steps on the left highlight lines in a growing file on
the right, ending in a runnable `examples/` project and its run recording. Start with one:
"Build a support triage network" (fan-out, aggregator, human approval, streaming). It reuses the
landing page's recorded run.

### Reference

Generated from the API Extractor reports that already exist (`packages/core/api/*.api.md`) plus
TSDoc: signatures, parameter tables, errors thrown. Concept pages link to it with hover cards
(`<Api name="AgentNetwork.setup" />`) instead of restating parameter lists.

## Navigation (Agents tab)

- **Start:** Introduction (why events, when not to use m4trix), Install, Quickstart, Mental
  model (one animated overview with the legend).
- **Concepts:** Events, Channels, Agents, Networks and wiring, Runs and lifecycle, Streaming and
  proxies, Tools, Skills, Dependency layers, Aggregators and `emitAndAwait`, History and stores,
  Tenancy and principals, Limits and usage.
- **Guides:** the split how-to pages, grouped as Frontend and streaming, Tools and models,
  Multi-agent patterns, Production (auth, errors, observability, scaling, deployment), Testing.
- **Examples:** a gallery of cards with run thumbnails, each linking to its `examples/` project
  and its run player.
- **Reference:** generated.
- **Project:** versioning, changelog, migrations, FAQ, security, contributing.

Evals and Tracing get the same Start / Concepts / Guides / Reference shape at their size.

## Rollout

1. **Foundations (1–2 days).** `<Snippet>` (file include, regions, line highlights), `<Figure>`
   with caption, `<Steps>`, the legend, and moving the visual lib into `@m4trix/docs-ui`.
2. **Pilot: the Channels concept page, end to end.** Snippet file, recording, `<RunPlayer>`,
   generated walkthrough, topology diagram and template sections. Review it before scaling.
3. **Concepts.** Write or rewrite the 13 concept pages on the template; split `how-to.mdx`.
4. **Learn.** The triage tutorial with `<CodeWalkthrough>`; the examples gallery.
5. **Reference and checks.** Generated reference, twoslash, and CI for snippet typechecks,
   links, re-recorded runs (fail when a recording's shape changes), and an `llms.txt` diff.

## Checks that keep it honest

- Snippets typecheck and run in CI.
- Recordings are regenerated when `packages/core` changes; a changed event sequence fails CI
  until it is re-recorded and reviewed.
- Every internal link resolves (`resolveDocLink` already does this for rendering).
- Every page has a description; every figure has alt text and a text equivalent in its `.md`.
