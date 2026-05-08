# Install

Install `@m4trix/core` using your preferred package manager:

```bash
# Using pnpm (recommended)
pnpm add @m4trix/core

# Using npm
npm install @m4trix/core

# Using yarn
yarn add @m4trix/core
```

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

Matrix uses [Effect](https://effect.website/) for schema validation and concurrency. It's included as a dependency — no additional setup needed.

## Next

- [Hello World](hello-world.md) — Copy/paste your first agent network
