---
paths:
  - "packages/**/*.{ts,tsx,js,jsx,mjs,cjs}"
  - "scripts/**/*.{ts,js,mjs}"
---

# Format at end of task

When a coding task is **finished**, run Biome **once** on **changed files only** — not after every edit, and not across the whole repo.

## Changed files only

```bash
pnpm exec biome format --write path/to/changed-file.ts
```

## Package scope (all changes in one package)

If every changed file is under the same `packages/<name>/`:

```bash
pnpm --filter @m4trix/tracing format
pnpm --filter @m4trix/trace-viewer format
pnpm --filter @m4trix/core format
```

Use package format when multiple files in one package changed. Use explicit paths when changes are scattered or at the repo root.

## Do not

- Run root `pnpm format` (formats the entire monorepo)
- Re-format on every intermediate edit
- Format unrelated packages or untouched files

Skip if the task did not modify formattable source files.
