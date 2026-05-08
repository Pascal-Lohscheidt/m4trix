# FAQ / Troubleshooting

## Installation

### Peer dependency warnings

Matrix uses [Effect](https://effect.website/) for schema validation. It's included as a dependency — no extra setup needed. If you see peer dependency warnings, ensure your Node.js and package manager versions are compatible.

### TypeScript errors

Ensure you have `"moduleResolution": "bundler"` or `"node16"` in your `tsconfig.json` if you use modern imports. m4trix ships with TypeScript types.

## Runtime

### SSE not streaming / connection hangs

- Ensure your deployment platform supports streaming responses (Vercel, Node.js do; some edge runtimes may not)
- Check that the client channel has `sink.httpStream()` attached
- Verify `expose()` has `select: { channels: 'client' }` (or your output channel name)

### Events not reaching the agent

- Confirm the agent is registered with `subscribe(main)` (or the channel where start events are published)
- Check that the start event name in `expose()` matches the event your agent `listensTo`
- Ensure the payload schema matches — invalid payloads may be rejected before reaching the agent

### Auth failing

- The `auth` callback receives a request-like object. Ensure you're reading headers correctly (e.g. `req.request?.headers?.get?.('authorization')`)
- Return `{ allowed: false, message: '...', status: 401 }` for auth failures

## Evals

### eval-agents-simple not found

Ensure `@m4trix/evals` is installed and the CLI is in your `node_modules/.bin`. Run via `pnpm exec eval-agents-simple` or add a script in `package.json`.

### Dataset or evaluator not found

- Check that your files use the correct suffixes (`.dataset.ts`, `.evaluator.ts`, `.test-case.ts`)
- Verify `m4trix-eval.config.ts` if you use custom discovery paths
- Names are matched by string or pattern — use exact names or glob patterns like `*Demo*`

## Getting Help

- [GitHub Issues](https://github.com/Pascal-Lohscheidt/m4trix/issues)
- [pascal@stepsailor.com](mailto:pascal@stepsailor.com)
