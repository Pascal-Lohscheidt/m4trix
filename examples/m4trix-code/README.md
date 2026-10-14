# m4trix-code

A simplified Claude Code clone: a terminal coding agent whose agent loop is an `@m4trix/core` event network instead of a `while` loop.

```bash
cp .env.example .env   # then fill in OPENAI_API_KEY; loaded at startup
pnpm --filter m4trix-code start                         # REPL in the current directory
pnpm --filter m4trix-code start -- -p "fix the typo in README.md" --yes --cwd ../some-repo
```

Options: `-p <prompt>` one-shot, `--yes` auto-approve writes and commands, `--cwd <dir>` workspace, `--model <id>` (default `gpt-5.4`, or `M4TRIX_CODE_MODEL`), `--max-steps <n>` (default 60), `--context-budget <tokens>` (default 100000: the conversation the model sees, see below), `--trace` console tracing. REPL commands: `/help`, `/clear`, `/exit`. Ctrl+C cancels the running turn.

## How the loop is wired

One user turn is one run. Channels: `main` (start event), `loop` (agent loop), `client` (SSE proxy the terminal reads and answers permissions on).

```
user-prompt ─▶ model ─▶ model-step + tool-call-requested ×N ─▶ tool-runner ─▶ tool-result ×N
                 ▲                                                                  │
                 └──── step-completed ◀── step-collector (EventAggregator) ◀────────┘
model (no tool calls) ─▶ assistant-message ─▶ endsOn ─▶ m4trix:run.completed
model (view over budget) ─emitAndAwait─▶ compaction-requested ─▶ compactor ─▶ context-compacted
write_file / edit_file / bash ─emitAndAwait─▶ permission-requested ─▶ terminal ─▶ permission-resolved
```

- **The store is the conversation.** A session keeps one `contextId`, so turns share memory and `/clear` just switches context. Token deltas are transient and never stored.
- **Tools** (`src/tools.ts`): `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `bash`, scoped to the `Workspace` layer. The model gets them via `toOpenAITools()`; failures come back as results through `executeForModel()`.
- **Model** is a dependency layer (`src/layers.ts`, OpenAI Chat Completions over `fetch`); swap it for any provider.
- **Limits:** `maxSteps` bounds a turn; the network's `maxDepth`/`maxEvents` are derived from it (each tool round trip is three hops).

## How context works

The model never re-reads the raw history. It reads [context folds](https://m4trix.dev/docs/concepts/context) (`src/context.ts`), which the runtime caches per conversation and updates incrementally (each step only folds the events since the last read):

- **`Conversation`** is a segmented fold over `user-prompt`, `model-step`, `tool-result` and `assistant-message`. A segment is atomic: a prompt, a model step **with all of its tool results**, or an answer. Rendering (`toChatMessages`) puts every tool result right after its step, in call order, and gives a call without a result (an interrupted turn) a placeholder, so the API never sees an unanswered tool call.
- **`chat`** (`createChatView(budget)`) is the model agent's view of it, budgeted by `--context-budget` (≈ JSON chars / 4 of the conversation; the system prompt and tool schemas are not counted). While over budget it first cuts old tool outputs to 400 characters (all but the newest 3 segments), then drops whole old segments, never the current turn.
- **Compaction.** When the view could not keep everything (it dropped segments, or is still over budget because the current turn alone is too big) and there are more than 4 segments, the model agent sends `compaction-requested` with `emitAndAwait` before calling the model. The **compactor** agent reads the full `Conversation`, has the model summarize everything but the newest 4 segments (an earlier summary included), and answers with `context-compacted`: the summary plus the kept segments. That event is the fold's checkpoint, so from then on the conversation starts there, also when the state is rebuilt from the store. The summary is sent to the model as a system message before the kept segments; the terminal shows `⎿ compacted N segments into a summary`. Compaction runs while the model agent is the only active agent, so no event slips in between the compactor's read and its checkpoint.
- **`StepProgress`** is a run-scoped fold over `model-step` and `tool-result`. It counts the turn's steps (`--max-steps`) and lets `step-collector` emit `step-completed` exactly once per step: on the result that fills the step's last slot.

A tiny budget (e.g. `--context-budget 2000`) makes compaction visible within a single turn; it then compacts on most steps.

## Tests

```bash
pnpm exec vitest run examples/m4trix-code   # from the repo root
```

`src/context.spec.ts` covers the folds and the view (step and results never separated, placeholders, checkpoint summary first, exactly-once step completion), checks that the network's wiring has no warnings, and drives a turn with a tool step and a forced compaction through the real network with a scripted `Model` layer (no API calls).
