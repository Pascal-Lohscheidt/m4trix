---
title: "Security Considerations"
---

## API Keys and Secrets

- **Never** commit API keys, tokens, or secrets to the repository
- Use environment variables (`process.env.OPENAI_API_KEY`, etc.) and inject them in agent logic
- Use your platform's secret management (Vercel, AWS Secrets Manager, etc.)

## Authentication

- Use the `auth` callback in `expose()` to validate tokens or sessions before processing requests
- Return the request's **principal** (`{ allowed: true, principal: { id } }`) so its history is namespaced: the `contextId` comes from the client and is not a secret
- Return appropriate HTTP status codes (401, 403) when auth fails
- Do not log sensitive tokens or credentials

## Input Validation

- Event payloads are validated via Effect Schema at runtime
- Invalid payloads are rejected before reaching agent logic
- For custom validation, add checks in `onRequest` or at the start of your agent logic

## Multi-Tenant Isolation

- History is stored and read per `(principal, contextId)`. Requests without a principal share one anonymous namespace where anyone who knows a `contextId` reads that conversation; do not rely on it for multi-user apps
- Runs belong to their principal: events for another principal's run are refused, and streams only yield their own principal's events
- Proxy publishes never trust `meta.principalId`; pass `principal` explicitly from your server-side auth (see [Auth + Multi-Tenant](../guides/auth-multitenant.md))
- Store adapters must scope every read and write by both `namespace` and `contextId` (check yours with `runStoreContract` from `@m4trix/core/testing`)
- Keep per-tenant resources (credentials, indexes) behind dependency layers selected by the run's `principal`
- Avoid sharing mutable state between tenants

## Dependencies

- Keep `@m4trix/core` and `@m4trix/evals` up to date for security patches
- Run `pnpm audit` (or equivalent) regularly

## Reporting Vulnerabilities

Please report security issues privately to [pascal@stepsailor.com](mailto:pascal@stepsailor.com) before opening a public issue.
