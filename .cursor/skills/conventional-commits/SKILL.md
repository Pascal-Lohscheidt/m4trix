---
name: conventional-commits
description: >-
  Writes conventional commit messages for the m4trix monorepo so entries route
  to the correct Mintlify changelog (Agents, Evals, Tracing). Use when the
  user asks for a commit message, conventional commit, git commit help, staged
  changes summary, or before committing package changes.
---

# Conventional commits (m4trix)

Write commits that match [Conventional Commits](https://www.conventionalcommits.org/) **and** appear in the auto-generated docs changelogs (`pnpm changelog`).

## Before writing

1. Inspect the change set: `git status`, `git diff`, and/or `git diff --cached`.
2. Note which paths changed under `packages/`.
3. Prefer **one logical change per commit**. Split unrelated work (e.g. evals + tracing) into separate commits with correct scopes.

Source of truth for scope → changelog tab: `scripts/changelog-config.ts`.

## Format

```
<type>(<scope>): <description>

[optional body — bullets ok]

[optional footers: Closes #123, BREAKING CHANGE: ...]
```

- **Subject**: imperative, lowercase, no trailing period, ≤72 chars when possible.
- **Description**: what changed for **users** of the package, not internal refactors-only wording unless type is `refactor`.
- **Scope**: required for changelog routing when more than one package could apply.

## Types and changelogs

| Type | In changelog? | Use when |
|------|---------------|----------|
| `feat` | Yes (Features) | New capability, API, CLI flag, UX |
| `fix` | Yes (Fixes) | Bug fix, regression, incorrect behavior |
| `perf` | Yes (Performance) | Measurable speed/memory win |
| `refactor` | Yes (Improvements) | Structure/cleanup; behavior unchanged |
| `docs` | No | Mintlify, README, comments only |
| `test` | No | Tests only |
| `chore` | No | Tooling, lockfile, format, CI |
| `ci` | No | Workflows, pipeline |
| `style` | No | Formatting only |

Product changes in `packages/*` should use **`feat` / `fix` / `perf` / `refactor` with a scope**, not `chore:` or unscoped `feat:`.

## Scopes → changelog tab

| Scope | Changelog tab | Package path |
|-------|---------------|--------------|
| `core`, `matrix` | Agents | `packages/core/` |
| `stream` | Agents | `packages/stream/` |
| `react` | Agents | `packages/react/` |
| `ui` | Agents | `packages/ui/` |
| `evals` | Evals | `packages/evals/` |
| `tracing` | Tracing | `packages/tracing/` |
| `trace-viewer` | Tracing | `packages/trace-viewer/` |

- Use **`matrix`** for AgentFactory, AgentNetwork, channels, endpoints (core matrix entry).
- Use **`core`** for shared core APIs outside matrix-specific surfaces.
- Typo alias `traceer` works but prefer **`trace-viewer`**.
- Touching two packages in one commit: `feat(tracing,trace-viewer): ...` (comma-separated, no spaces).

If scope is omitted, routing falls back to changed paths — **always set scope explicitly** for predictable changelogs.

## Breaking changes

- Subject: `feat(core)!: remove legacy channel API`
- Body footer:

  ```
  BREAKING CHANGE: ChannelFactory.create() removed; use AgentNetwork.bind() instead.
  ```

## Description quality (Mintlify)

Changelog lines use the subject description verbatim. Write so a reader understands the **benefit**:

- Good: `feat(evals): add tag filters to dataset selection`
- Bad: `feat(evals): wip`, `fix(tracing): stuff`, `feat: updates`

Avoid: `docs: update`, `chore: fix`, `ci: tweak` for shipped product behavior.

## Workflow

1. Classify each changed area → scope(s) from the table.
2. Pick the **smallest accurate type** (`fix` not `feat` for bugs).
3. Draft subject; add body only if context helps (migration steps, issue link).
4. If multiple tabs affected with unrelated changes → **split commits**.
5. Offer the final message in a single fenced block for copy-paste.

Do **not** run `git commit` unless the user asked to commit.

## Quick checklist

- [ ] Type is `feat` | `fix` | `perf` | `refactor` for package product work
- [ ] Scope matches `packages/<name>/` (or comma list)
- [ ] Description is user-facing and specific
- [ ] Breaking changes use `!` and `BREAKING CHANGE:` footer
- [ ] Docs-only / CI-only changes use `docs` / `ci` / `chore` (won't appear in product changelog)

## Examples

See [examples.md](examples.md) for good and bad messages from this repo.

Changelog pages live at `docs/{project,evals,tracing}/changelog.mdx` (Mintlify requires **`.mdx`** for the `<Update>` component). Version labels are derived from **git tags** (`@m4trix/<pkg>@x.y.z`), not `package.json`.

After merging user-facing commits, changelogs refresh with:

```bash
pnpm changelog:commit
```
