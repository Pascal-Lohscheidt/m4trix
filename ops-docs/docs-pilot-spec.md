# Docs pilot: contracts

The pilot rebuilds the **Channels** concept page end to end with the system in
[docs-system.md](./docs-system.md): compiled snippets, a recorded run, a live run player, a
generated walkthrough and a topology diagram. This file is the contract between the pieces so
they can be built in parallel. Change it only together with every piece that depends on it.

## Ground rules (every workstream)

- Don't commit. Stay on `main`.
- Never run `next build` / `pnpm build` inside `website/`; the maintainer's `next dev` (port 3000)
  shares `website/.next`. To check a production build, `rsync` `website/` (minus `.next` and
  `node_modules`) into a sibling temp dir at the same depth, copy `node_modules` (pnpm symlinks
  are relative), build there, delete it. `next.config` may need
  `typescript: { ignoreBuildErrors: true }` in the copy only: `AgentRunReplay.tsx` has a
  pre-existing type error unrelated to the docs.
- Read-only requests against `http://localhost:3000` (the maintainer's dev server) are fine.
- Don't edit files outside your workstream's list without saying so in your report. The website
  has unrelated uncommitted work (landing components, `tailwind.css`); leave it alone.
- Dependencies are installed already (`@shikijs/twoslash`, `tsx`, `docs-visual-gen` as a
  workspace dep of the website, React 18.3.1 in both). Don't run `pnpm add`; if something is
  missing, say so.
- Website is Next 14.2 app router, React 18.3.1, Tailwind v4. Docs styles live in
  `website/src/styles/docs.css` inside `@layer components`, using the site tokens (`--bg`,
  `--bg-raised`, `--text-1..4`, `--border`, `--border-md`, `--accent`, `--accent-dim`,
  `--accent-border`, `--accent-text`) and work in `[data-mode="dark"]` (default) and
  `[data-mode="light"]`.
- When done, run `pnpm exec biome check --write <changed files>` from the repo root and
  `npx tsc --noEmit -p website` (ignore the `AgentRunReplay.tsx` error).

## Snippets

- Real files: `website/content/snippets/**/*.ts`, typechecked by `pnpm --filter website
  docs:snippets` with `website/content/snippets/tsconfig.json`, which maps
  `@m4trix/core/matrix` to `packages/core/src/matrix/index.ts`.
- Regions: `// #region <name>` … `// #endregion <name>`. Output strips every region marker line
  and dedents.
- Pilot snippet: `website/content/snippets/concepts/channels.ts` (regions `events`, `agents`,
  `wiring`). It exports the events, the agents (`router`, `worker`, `auditLog`), `network` and
  `scenario`.
- A snippet is **recordable** when it exports `network` (an `AgentNetwork`) and `scenario`
  (`{ start: <unbound event from Event.make(...)> }`). Exported agents are named by their export
  name.

### `<Snippet>` (MDX)

```mdx
<Snippet file="concepts/channels.ts" region="wiring" title="network.ts" highlight="4-6" />
```

| Prop | Meaning |
| --- | --- |
| `file` | Path under `content/snippets`. |
| `region` | Optional. One region name, or several comma-separated (joined in file order). Absent = whole file minus region markers. |
| `title` | Optional header label. Default: the file's basename. |
| `highlight` | Optional line ranges **relative to the shown code**, e.g. `"2,4-6"`. |
| `twoslash` | Optional, default `true` for `ts`/`tsx`: hover types and `// ^?` queries via `@shikijs/twoslash`. `twoslash={false}` turns it off. |

Rendered with the existing `CodeFrame` look (header with title and copy button). In the `.md`
output (`/docs/<slug>.md`, `llms-full.txt`, MCP `get_page`) it becomes a fenced block:
```` ```ts title="network.ts" ```` with the resolved code (no twoslash annotations).

Server helper the run player also uses:

```ts
// website/src/lib/docs/snippets.ts
export async function readSnippet(file: string, region?: string): Promise<{
  code: string;        // resolved, dedented
  lang: string;        // from the extension
  startLine: number;   // 1-based line in the source file of the first shown line
  lineMap: number[];   // lineMap[i] = 1-based source line of shown line i (0-based i)
}>;
```

## Recordings

- Script: `website/scripts/record-docs-runs.mts`, run with `pnpm --filter website docs:record`
  (tsx with the snippets tsconfig, so `@m4trix/core/matrix` resolves to core's source).
- For every recordable snippet it runs one run with the real runtime (no mocks needed for the
  pilot) and writes `website/content/runs/<snippet path without .ts>.json`, e.g.
  `content/runs/concepts/channels.json`.
- Output must be **deterministic** (no timestamps, random ids or durations), so recordings diff
  cleanly. `--check` re-records into memory and exits 1 when any file differs.
- Fails when the network's wiring has warnings, when the run doesn't end with
  `m4trix:run.completed`, or when a snippet exports `network` without `scenario`.
- Types shared with the player live in `website/src/lib/docs/runs/types.ts`:

```ts
export interface DocsRun {
  version: 1;
  id: string; // 'concepts/channels'
  snippet: string; // 'concepts/channels.ts'
  topology: {
    mainChannel: string;
    channels: Array<{
      name: string;
      events: string[] | null; // .events([...]) declaration; null = carries every event
      proxies: string[]; // proxy kinds, e.g. ['sse']
    }>;
    agents: Array<{
      name: string; // export name in the snippet
      listensTo: string[] | null; // null = catch-all
      emits: string[] | null;
      subscribes: string[]; // channel names
      publishesTo: string[];
    }>;
    terminalEvents: string[];
  };
  events: Array<{
    i: number; // publish order, 0-based
    name: string;
    channels: string[]; // channels it was published on
    by: string | null; // agent name; null = published from outside (the scenario / expose)
    cause: number | null; // index of the event whose handling emitted it
    payload: unknown;
    deliveredTo: string[]; // agents invoked with this event, in invocation order
    line: number | null; // 1-based line in the snippet file that creates it (emit call or scenario)
    replyTo?: string; // set on an emitAndAwait reply: the waiting agent that receives it
  }>;
  end: { name: string }; // e.g. 'm4trix:run.completed'
  /** One Markdown sentence per event, names in backticks. Generated, not hand-written. */
  walkthrough: string[];
}
```

`events` includes the run's own `m4trix:*` lifecycle events only if they are published on a
channel; `end` always carries how the run ended.

## Shared visuals (`docs-visual-gen/src/lib`)

- The website imports it as `docs-visual-gen/lib` (workspace dependency; package `exports`
  maps `./lib` to `./src/lib/index.ts`). It must therefore work with React 18 (no `ref` as a
  plain prop; use `forwardRef`), with Next's `transpilePackages`, and must not leak global
  styles: no `html`/`body`/`*` rules, no `:root` tokens; everything scoped under the frame and
  prefixed (`dv-`) so it can't collide with website classes.
- It needs a dark variant: tokens on `.dv-frame`, switched by `data-theme="dark" | "light"` on
  the frame, or following the nearest `[data-mode]` ancestor when `theme="auto"`.
- It needs a responsive wrapper: render at canvas size, scale to the container's width,
  keeping the aspect ratio.
- `docs-visual-gen` keeps rendering its three scenes exactly as before (light theme).

## Run player and diagrams (website)

MDX components, server wrappers that read `content/runs/<run>.json` and render client parts:

```mdx
<NetworkDiagram run="concepts/channels" />           // static topology, shared visuals
<RunPlayer run="concepts/channels" region="agents,wiring" />  // animated, step-based
<RunWalkthrough run="concepts/channels" />           // ordered list of run.walkthrough
```

- **Layout from topology** (no hand positions): channels are lanes, main first; an agent sits
  where the lane(s) it subscribes to meet the lane(s) it publishes to; proxies are ports on the
  network's border; the outside world (scenario / browser) is left of `expose()`.
- **Player is step-based**, not timed: step *n* shows event *n* travelling from its publisher
  into its channel(s) and to `deliveredTo`. Controls: play/pause, previous/next step, a step
  scrubber, the current `walkthrough[n]` as caption, and the current event's payload on demand.
  Under `prefers-reduced-motion` it doesn't autoplay and steps without travel animation.
- **Linked code:** with `region`, the player shows that snippet beside or below the stage and
  highlights `events[n].line` (via `readSnippet().lineMap`) on each step.
- `.md` output: `NetworkDiagram` becomes a short text description of the topology (channels
  with declared events and proxies, agents with subscribe → publish); `RunPlayer` and
  `RunWalkthrough` become the numbered walkthrough.
