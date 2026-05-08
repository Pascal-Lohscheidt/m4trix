# Security Considerations

## API Keys and Secrets

- **Never** commit API keys, tokens, or secrets to the repository
- Use environment variables (`process.env.OPENAI_API_KEY`, etc.) and inject them in agent logic
- Use your platform's secret management (Vercel, AWS Secrets Manager, etc.)

## Authentication

- Use the `auth` callback in `expose()` to validate tokens or sessions before processing requests
- Return appropriate HTTP status codes (401, 403) when auth fails
- Do not log sensitive tokens or credentials

## Input Validation

- Event payloads are validated via Effect Schema at runtime
- Invalid payloads are rejected before reaching agent logic
- For custom validation, add checks in `onRequest` or at the start of your agent logic

## Multi-Tenant Isolation

- When building multi-tenant apps, ensure tenant context is passed correctly (e.g. via `onRequest` enriching the payload)
- Use the spawner pattern for per-tenant agent instances when isolation is critical
- Avoid sharing mutable state between tenants

## Dependencies

- Keep `@m4trix/core` and `@m4trix/evals` up to date for security patches
- Run `pnpm audit` (or equivalent) regularly

## Reporting Vulnerabilities

Please report security issues privately to [pascal@stepsailor.com](mailto:pascal@stepsailor.com) before opening a public issue.
