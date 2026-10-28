# m4trix-code

A simplified Claude Code clone: a terminal coding agent whose agent loop is an `@m4trix/core` event network instead of a `while` loop.

```bash
cp .env.example .env   # then fill in OPENAI_API_KEY; loaded at startup
pnpm --filter m4trix-code start                         # REPL in the current directory
pnpm --filter m4trix-code start -- -p "fix the typo in README.md" --yes --cwd ../some-repo
pnpm --filter m4trix-code start -- --session ~/.m4trix-code/my-repo   # continues where it left off
```

Options: `-p <prompt>` one-shot, `--yes` auto-approve writes and commands, `--cwd <dir>` workspace, `--session <dir>` keep the conversation in that directory (see [Sessions](#sessions)), `--model <id>` (default `gpt-5.4`, or `M4TRIX_CODE_MODEL`), `--max-steps <n>` (default 60), `--context-budget <tokens>` (default 100000: the conversation the model sees, see below), `--trace` console tracing. REPL commands: `/help`, `/clear` (a new conversation), `/exit`. Ctrl+C cancels the running turn.

## How the loop is wired

One user turn is one run. Channels: `main` (start event), `loop` (agent loop), `client` (SSE proxy the terminal reads and answers permissions on).

```
user-prompt ─▶ model ─▶ model-step + tool-call-requested ×N ─▶ tool-runner ─▶ tool-result ×N
                 ▲                                                                  │
                 └──── step-completed ◀── step-collector (EventAggregator) ◀────────┘
model (no tool calls) ─▶ assistant-message ─▶ endsOn ─▶ m4trix:run.completed
model (view does not fit) ─folds.conversation.compact()─▶ m4trix:fold.checkpoint (stored) + context-compacted (notice)
write_file / edit_file / bash ─emitAndAwait─▶ permission-requested ─▶ terminal ─▶ permission-resolved
```

- **The store is the conversation.** A conversation is one `contextId`, so turns share memory; `/clear` switches to a new one. Token deltas and compaction notices are transient and never stored.
- **Tools** (`src/tools.ts`): `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `bash`, scoped to the `Workspace` layer. The model gets them via `toOpenAITools()`; failures come back as results through `executeForModel()`.
- **Model** is a dependency layer (`src/layers.ts`, OpenAI Chat Completions over `fetch`); swap it for any provider.
- **Limits:** `maxSteps` bounds a turn; the network's `maxDepth`/`maxEvents` are derived from it (each tool round trip is three hops).

## How context works

The model never re-reads the raw history. It reads [context folds](https://m4trix.dev/docs/concepts/context) (`src/context.ts`), which the runtime caches per conversation and updates incrementally (each step only folds the events since the last read):

- **`Conversation`** is a segmented fold over `user-prompt`, `model-step`, `tool-result` and `assistant-message`. A segment is atomic: a prompt, a model step **with all of its tool results**, or an answer. Rendering (`toChatMessages`) puts every tool result right after its step, in call order, and gives a call without a result (an interrupted turn) a placeholder, so the API never sees an unanswered tool call.
- **`ChatView`** is the model agent's [view](https://m4trix.dev/docs/concepts/context#views-and-contextstrategy) of it: a function the agent calls on each step with the conversation it read and the `--context-budget` (`ChatView(conversation, { budget })`; ≈ JSON chars / 4 of the conversation, the system prompt and tool schemas are not counted). While over budget it first cuts old tool outputs to 400 characters (all but the newest 3 segments), then drops whole old segments, never the current turn (`ContextStrategy.fromNewest(Conversation, 'user')`).
- **Compaction.** The model agent reads the conversation through core's compaction policy: `folds.conversation.compact({ view: ChatView, budget, keepTokens, keepFrom: ContextStrategy.newest(), summarize })`. It compacts when the view does not hold the whole conversation within budget (`!chat.fits`: it dropped segments, or the current turn alone is over budget) and something is older than what a compaction keeps. The newest segments that fit `keepTokens` (half the budget by default) stay verbatim, always at least the newest one, so a long turn's own prompt and earlier steps can be summarized too. The model summarizes everything older (an earlier summary included) in a tool-less call. The runtime stores the result as the fold's checkpoint (`m4trix:fold.checkpoint:conversation@1`, never streamed), so from then on the conversation starts there, also after a restart. An event published while the summary is written (e.g. a late tool result) is not lost: the checkpoint records the read it was cut from (`through`), and everything after it is folded on top. Keeping half the budget leaves room for the summary and the next steps, so the view fits again afterwards instead of compacting on every step. The summary is sent to the model as a system message before the kept segments; the terminal shows `⎿ compacted N segments into a summary`.
- **Summaries stay small.** A summary request holds at most one `--context-budget` of transcript (tool outputs cut to 1500 characters); more is summarized in chunks, oldest first, each request carrying the summary so far (`compactionChunks`). This is needed in normal operation, not only in rare cases. The view decides whether the conversation fits after eliding old tool outputs, but a compaction summarizes the older segments with their outputs in full. So the first compaction of a tool-heavy turn sends more than a budget: in the tests, 4010 transcript tokens at a budget of 3000, in two requests; measured with `ChatView`, its older segments come to about 1.5 budgets at budgets of a few thousand and about twice the budget at the 100k default. After a `version` bump of `Conversation` its checkpoints no longer apply: the first read folds the whole history again, and the first compaction summarizes all of it, which can exceed the model's window in a long session.
- **`StepProgress`** is a run-scoped fold over `model-step` and `tool-result`. It counts the turn's steps (`--max-steps`) and lets `step-collector` emit `step-completed` exactly once per step: on the result that fills the step's last slot.

A tiny budget (e.g. `--context-budget 2000`) makes compaction visible within a single turn. It is for watching compaction, not for working: once one step's file reads take about half the budget, every compaction keeps only the newest step, and the agent re-reads what was summarized away.

## Sessions

Without `--session`, the conversation lives in the in-memory store and ends with the process. With `--session <dir>`, it is kept in that directory (`src/session.ts`), and the next start with the same directory continues it:

- `session.json` holds the `contextId` of the current conversation; `/clear` starts a new one there (the old one stays in the store).
- `events.jsonl` is the network's store (`src/file-store.ts`, `openFileNetworkStore`): one JSON line per durable event, `{"namespace", "contextId", "event"}`, appended, never rewritten. Payloads are stored as the runtime encodes them (JSON), the compaction checkpoints included. It passes core's `runStoreContract`.

The file store is small on purpose:

- **Reads** come from memory: the file is loaded once on open, and every read parses the stored JSON again, so readers get fresh, unfrozen objects, as from a database.
- **Cursors** are `jsonl:<n>`, the point after the conversation's first `n` events. Lines are never rewritten, so a cursor stays valid across restarts: checkpoints persist one (`through`). A cursor of another format, or past the end of the history, reads as a reset.
- **Durability:** an append resolves once its line is written and `fdatasync`ed, so a crashed process loses nothing it acknowledged. On power loss the last appends may be lost: on macOS `fdatasync` reaches the drive but not necessarily its platters, and the directory entry of a new file is not synced.
- **A torn last line** (the process died during an append) is dropped when the file is opened: a line counts once its newline is written. A malformed line anywhere else is corruption, and opening fails with its line number. After a failed append, the store refuses further appends (the turn fails with `store-error`), because the file may end in a torn line; restart to repair it.
- **One process per session.** Two processes on one directory would not see each other's events. There is no `deleteContext`: delete the directory to forget a session.

## Tests

```bash
pnpm exec vitest run examples/m4trix-code   # from the repo root
```

- `src/context.spec.ts` covers the folds and the view: a step and its results are never separated, calls without results get placeholders, the summary comes first, when the view does not fit and how a compaction cuts it, the summary chunks, and exactly-once step completion. It also checks that the network's wiring has no warnings. It drives turns through the real network with a scripted `Model` layer (no API calls):
  - a forced compaction that happens once and is not repeated on the next step;
  - a long turn that keeps the newest steps that fit `keepTokens`;
  - a restart: a compaction, then a new network over a new file store on the same session directory. It sends the model exactly the context a warm process does, with no warning logged.
  - a tool-heavy turn whose view fits on elided outputs, so its first compaction summarizes more than the budget, in chunks;
  - a version bump: the whole history is summarized again, in requests of at most the budget.
- `src/file-store.spec.ts` runs core's store contract on the file store, then covers reopening (namespaces kept apart), fresh objects, short writes, torn lines (multi-byte UTF-8 included) and corrupt ones, failed appends, and cursors across restarts.
- `src/session.spec.ts` covers the session directory: a new session, resuming it, `/clear`, and broken session files; `src/args.spec.ts` the CLI's arguments.
