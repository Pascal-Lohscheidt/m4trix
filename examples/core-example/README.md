# Core Example (Next.js App Router)

This example demonstrates reusable chat UI components that can be plugged into different transport/network implementations.

## Routes

- `/` - transport picker page.
- `/SSE` - SSE transport implementation (active example).
- `/tRPC` - placeholder route for the future tRPC implementation.
- `/sse/api` - SSE backend endpoint used by `/SSE`.
- `/trpc/api` - placeholder API endpoint for the future tRPC transport.

## Reusable UI Components

Shared chat UI lives under:

- `components/chat`
  - `agent-chat-ui.tsx`
  - `chat-messages.tsx`
  - `chat-composer.tsx`
  - `reasoning-sidebar.tsx`
  - `types.ts`
- `components/examples/example-shell.tsx`

The `/SSE` page wires these components to SSE-specific logic in:

- `features/sse/use-sse-agent-chat.ts`

This keeps rendering/UI concerns separate from transport logic, so `/tRPC` can reuse the same components and swap only the network hook.

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).
