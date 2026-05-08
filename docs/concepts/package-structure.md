# Package Structure

@m4trix/core is organized into multiple entry points. Import only what you need for tree-shaking and smaller bundles.

## Entry Points

```typescript
// Matrix — Event-driven agent orchestration (primary)
import {
  AgentFactory,
  AgentNetwork,
  AgentNetworkEvent,
  NextEndpoint,
  ExpressEndpoint,
  S,
} from '@m4trix/core/matrix';

// Stream utilities — Composable stream processing
import { Pump, ensureFullWords } from '@m4trix/stream';

// React hooks — Framework integration
import { useConversation, useSocketConversation } from '@m4trix/react';

// UI components — Visual elements for AI interfaces
import { AiCursor } from '@m4trix/ui';
```

## Matrix (Primary)

The **Matrix** entry point is the core. It provides:

- **AgentFactory** — Fluent builder for type-safe agents
- **AgentNetwork** — Orchestrator for wiring agents to channels
- **AgentNetworkEvent** — Schema-validated event definitions
- **Channels & Sinks** — Event routing with HTTP stream and Kafka sinks
- **NextEndpoint / ExpressEndpoint** — Framework adapters for exposing networks as APIs

## Stream Utilities

The `Pump` class provides composable stream processing with `map`, `filter`, `batch`, `bundle`, `rechunk`, and more.

## React Hooks

`useConversation` and `useSocketConversation` handle SSE connections and state management for React apps.

## Bundle Formats

All entry points are available in ESM and CommonJS, with TypeScript type definitions included.

## Tree-Shaking Benefits

- **Reduced Bundle Size** — Only the code you use gets included
- **Improved Performance** — Smaller bundles, faster load times
- **Framework Flexibility** — Use only the parts that fit your stack
