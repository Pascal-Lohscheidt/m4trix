---
title: "Install"
---

Install `@m4trix/core` and its peer dependency [Effect](https://effect.website/) using your preferred package manager:

```bash
# Using pnpm (recommended)
pnpm add @m4trix/core effect

# Using npm
npm install @m4trix/core effect

# Using yarn
yarn add @m4trix/core effect
```

Requires Node.js 20+; also runs on Edge runtimes (no Node built-ins, see [Deployment](../guides/deployment.md#edge--serverless)).

## Entry Points

@m4trix/core is organized into multiple entry points. Import only what you need:

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

// Stream utilities
import { Pump } from '@m4trix/stream';

// React hooks
import { useConversation } from '@m4trix/react';
```

The **Matrix** module is the primary entry point. It provides the full agent orchestration system including typed events, agent factories, network wiring, and HTTP adapters.

## Peer Dependencies

Matrix uses [Effect](https://effect.website/) (`^3.20`) for schema validation and concurrency. It is a peer dependency: install it next to `@m4trix/core` (see above), so your code and m4trix share one copy, and `S` (`Schema`) schemas you define work with it. `@m4trix/core` depends on nothing else.

## Next

- [Hello World](hello-world.md) — Copy/paste your first agent network
