---
title: "Contributing"
---

We welcome contributions! Please follow these guidelines.

## How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes following our commit conventions
4. Push the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**

- `feat` — A new feature
- `fix` — A bug fix
- `docs` — Documentation only
- `style` — Formatting, no logic change
- `refactor` — Code change, no new feature or fix
- `perf` — Performance improvement
- `test` — Tests
- `chore` — Build, tooling, etc.

**Example:**

```
feat(matrix): add retry support to agent logic

- Add optional retry config to AgentFactory
- Document in guides

Closes #123
```

## Changelog

Docs changelogs are generated from conventional commits. After merging product changes, run:

```bash
pnpm changelog:commit
```

This updates the Mintlify changelog pages for Agents, Evals, and Tracing (routed by commit scope). Version labels come from **git release tags** (`@m4trix/<package>@x.y.z`), not `package.json`. Use `--fetch-tags` if tags are only on the remote. Commits with `[skip ci]` so CI does not re-run.

## Principles

From the project README:

- **Event-driven** — Components communicate via events; loose coupling
- **Agent definition and orchestration decoupling** — Define agents separately from how they are composed
- **DX First** — Developer experience matters
- **TypeScript first** — Full type inference
- **Treeshaking friendly** — Import only what you need
- **Agnostic** — No vendor lock-in; adapters for different runtimes

## License

MIT. See the repository for the full license text.

---

Created by [Stepsailor](https://stepsailor.com) (Pascal Lohscheidt)
