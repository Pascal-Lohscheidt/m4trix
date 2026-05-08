# Contributing

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
