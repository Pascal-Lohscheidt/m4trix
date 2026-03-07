
[![CircleCI](https://dl.circleci.com/status-badge/img/gh/Pascal-Lohscheidt/m4trix/tree/main.svg?style=svg)](https://dl.circleci.com/status-badge/redirect/gh/Pascal-Lohscheidt/m4trix/tree/main)
[![npm version](https://img.shields.io/npm/v/@m4trix%2Fcore)](https://www.npmjs.com/package/@m4trix/core)
[![npm downloads](https://img.shields.io/npm/dm/@m4trix%2Fcore)](https://www.npmjs.com/package/@m4trix/core)
[![license](https://img.shields.io/npm/l/@m4trix%2Fcore)](https://www.npmjs.com/package/@m4trix/core)


# @m4trix/core - Contributor README

The readme of the package is available in `packages/core/README.md`.

A powerful TypeScript library for building AI-driven web applications. Use `@m4trix/core` for agents and matrix, `@m4trix/stream` for Pump, `@m4trix/react` for hooks, and `@m4trix/ui` for AiCursor.

# Roadmap

### Upcoming
 - [ ] publish documentation side on vercel
 - [ ] release v1
 - [ ] Add an example 
 - [ ] Add a changelog

 ---- 
### Goals down the line
 - [ ] Concurrency helper
 - [ ] More event mapper
 - [ ] More direct integrations
 - [ ] Solid and React hooks
 - [ ] Kafka support
 - [ ] Add github project for better project management
 - [ ] Add issue support for better bug tracking
 - [ ] Add contributing guide
 - [ ] MCP Support - the React of the MCP world
 - [ ] Plugin system. I would like people to be able to create Plugins for different section of the library and publish them in here as core package as a contributor. -> Inspired by [BetterAuth](https://www.better-auth.com/)
 

# Principles
  - **Event driven** – Components communicate via events; loose coupling and composability.
  - **Agent definition and orchestration decoupling** – Define agents separately from how they are orchestrated and composed.
  - Make product developers lives easier to implement AI features
  - DX First
  - Typescript first
  - Treeshaking friendly - You get what you need, nothing more, nothing less
  - API as readable as possible. What you read is what you get.
  - Agnostic. No vendor lock-in. Adapters... Adapters... Adapters...
  - Made with the brain of a product developer profcient in typescript - not half baked SDK with unstable types.




## Contributing - TBD

We welcome contributions! Please follow these guidelines:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes following our commit conventions (see below)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/) for our commit messages. This helps us maintain a clean and consistent git history.

Format:
```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Types:
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools

Example:
```
feat(auth): add OAuth2 authentication

- Add Google OAuth2 provider
- Implement token refresh flow
- Add user profile endpoint

Closes #123
```

## License

MIT - Beware that this does not cover the /docs folder, since it is using a Tailwind Template.

---

Created by the makers of [Stepsailor](https://stepsailor.com) (Pascal Lohscheidt) 