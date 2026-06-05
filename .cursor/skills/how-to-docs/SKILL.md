---
name: how-to-docs
description: >-
  Writes Mintlify How-to pages for m4trix — question-led sections with
  snippet-first, multi-file code examples. Use when the user asks to add a
  how-to section, write a "How to..." doc, document a specific workflow
  (e.g. frontend ↔ agent, auth, streaming), or expand getting-started/how-to.
---

# How-to docs (m4trix)

Create **question-led** docs that show *how* to accomplish one task. Each page answers a specific question with **partial snippets across files**, not full copy-paste apps.

## When to use this vs other doc types

| Doc type | Purpose |
|----------|---------|
| **How-to** (`docs/getting-started/how-to.md`) | "How do I …?" — task-focused, snippet-heavy, minimal prose |
| Concepts (`docs/concepts/`) | Mental models, architecture |
| Guides (`docs/guides/`) | Broader topics, setup walkthroughs |
| API Reference | Signatures, options tables |
| Examples | Runnable starters, full recipes |

Link out to concepts/guides/API for depth; don't duplicate them.

## File layout

**One scrollable page** in Getting Started:

```
docs/getting-started/how-to.md
```

- Each task is a top-level `## How to …` section on the same page.
- Use `---` horizontal rules between sections for visual separation.
- Mintlify renders a table of contents from `##` headings — no separate index page.

## Navigation

The page lives in **Getting Started** (Agents tab). It is already listed in `docs/docs.json` as `getting-started/how-to` — only edit nav if the page path changes.

When adding a new section, append a `## How to …` block to `how-to.md`; do not create new files.

## Page template

```markdown
---
title: "How to <do the thing>"
description: "One sentence: what the reader can do after reading."
---

<One paragraph: when you need this, what you'll wire together. Link to Concepts/Guides if helpful.>

## <Sub-question or step name>

<1–2 sentences max. Then snippets.>

### <Optional: which file>

\`\`\`ts
// path/to/file.ts
<snippet>
\`\`\`

## Related

- [Concept](../concepts/….md)
- [Guide](../guides/….md)
```

### Title rules

- Page `title`: **"How to …"** — imperative, specific (`How to communicate between frontend and agent`).
- Section headings (`##`): sub-questions or wiring steps (`## Expose the network as SSE`, `## Read the stream in React`).
- Avoid vague titles (`Patterns`, `Overview`).

## Snippet rules (critical)

**Snippets, not full files.** ~80%+ of code blocks should be partial.

1. **File path comment** on the first line when the snippet is file-specific:
   ```ts
   // app/api/chat/route.ts
   export const POST = NextEndpoint.from(api).handler();
   ```

2. **Ellipsis for omitted code** — use `// ...` or `...` inside blocks; never paste entire modules:
   ```ts
   const network = AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent }) => {
     const main = mainChannel('main');
     const client = createChannel('client').proxy(proxy.sse());
     registerAgent(agent).subscribe(main).publishTo(client);
   });
   ```

3. **Multi-file flow** — show the same task across layers in order (events → agent → network → expose → client). Label each block with its file path.

4. **Minimal imports** — only import lines relevant to the snippet; use `// import { AgentNetwork, ... } from '@m4trix/core/matrix'` when the import list is long.

5. **No boilerplate** — skip `package.json`, tsconfig, CSS, unless the how-to is specifically about that.

6. **Real APIs** — verify names against `packages/core`, `packages/react`, and `examples/`. Grep the repo before writing.

7. **Copy-paste safety** — each snippet should be logically correct in isolation; use `...` where context is assumed, not invalid syntax.

## Prose rules

- Opening paragraph: max 3 sentences.
- Before each snippet group: max 2 sentences explaining *what this piece does*.
- No step-numbered essays; use `##` sections instead.
- Prefer tables only for small option comparisons (≤5 rows).
- End with **Related** links (3–5 max).

## Workflow

1. **Clarify the question** — restate as `How to <verb> <object>` (ask if ambiguous).
2. **Find source truth** — search `packages/`, `examples/`, existing `docs/`.
3. **Outline sections** — list `##` sub-questions; each maps to 1–3 snippet blocks.
4. **Draft snippets first**, then add minimal prose around them.
5. **Create/update** `docs/getting-started/how-to.md` — append or edit a `##` section.
6. **Cross-link** from related guides/concepts if a single sentence helps discovery (optional, ≤1 link per section).

Do **not** run `pnpm format` on markdown unless you also changed formattable source files.

## Quality checklist

- [ ] Section heading is `## How to …` and matches the user's question
- [ ] Code is mostly partial snippets with file path comments
- [ ] Multi-file flows show backend → expose → frontend (when applicable)
- [ ] APIs verified against repo (no hallucinated exports)
- [ ] Section added to `docs/getting-started/how-to.md` (single scrollable page)
- [ ] Related links point to existing docs

## Examples

See [examples.md](examples.md) for a full page following this format.
