# RAG + Tools

Build agents that use retrieval-augmented generation (RAG) or tool-calling patterns.

## Approach

1. **Define events** — e.g. `rag-request` (query + context) and `rag-response` (answer chunks)
2. **Agent logic** — Fetch from your vector store, build context, call the LLM with the augmented prompt
3. **Streaming** — Emit response chunks as they arrive from the LLM

## Tool-Calling Pattern

For agents that call tools (e.g. search, calculator):

1. Emit a `tool-request` event with the tool name and params
2. Another agent (or external system) handles the tool and emits `tool-response`
3. The original agent receives `tool-response` and continues

This can be implemented with multiple agents on different channels, or with a single agent that manages tool state internally.

## Example Repos

- **core-example** — Basic streaming agent; extend with RAG by adding retrieval before the LLM call
- **open-ai-speech-to-speech-example** — Uses OpenAI Realtime API; shows integration patterns

## Common Recipes

See [Common Recipes](common-recipes.md) for copyable snippets (retrieval, tool loops, etc.).
