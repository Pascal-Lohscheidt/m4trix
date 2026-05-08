---
title: "Next Steps"
---

After completing the 10-minute quick start, explore these paths:

## Understand the Concepts

<Columns cols={2}>
  <Card title="Events" icon="radio" href="/concepts/events">
    Learn how typed messages move through the system.
  </Card>
  <Card title="Channels" icon="route" href="/concepts/channels">
    Understand routing, sinks, and event delivery.
  </Card>
  <Card title="Agents" icon="bot" href="/concepts/agents">
    Build units of logic with lifecycle and type inference.
  </Card>
  <Card title="Networks" icon="network" href="/concepts/networks">
    Wire agents and channels into a running event plane.
  </Card>
</Columns>

## Build Real Things

<Columns cols={2}>
  <Card title="Patterns" icon="workflow" href="/guides/patterns">
    Request/response, fan-out, join, and retry patterns.
  </Card>
  <Card title="Streaming" icon="activity" href="/guides/streaming">
    SSE, backpressure, and chunking guidance.
  </Card>
  <Card title="Next.js" icon="panel-top" href="/guides/next.js">
    Expose networks through Next.js App Router routes.
  </Card>
  <Card title="Express" icon="server" href="/guides/express">
    Expose networks through an Express route.
  </Card>
</Columns>

## API Reference

<Columns cols={2}>
  <Card title="AgentFactory" icon="factory" href="/api-reference/agent-factory">
    Builder API for type-safe agents.
  </Card>
  <Card title="AgentNetwork" icon="waypoints" href="/api-reference/agent-network">
    Orchestration, setup, and runtime wiring.
  </Card>
  <Card title="IO + Adapters" icon="plug" href="/api-reference/io-adapters">
    NextEndpoint, ExpressEndpoint, and streaming adapters.
  </Card>
</Columns>

## Examples

<Columns cols={2}>
  <Card title="Minimal Starter" icon="sparkles" href="/examples/minimal-starter">
    Start from the smallest working setup.
  </Card>
  <Card title="Multi-Agent Workflow" icon="git-branch" href="/examples/multi-agent-workflow">
    Chain agents into a larger workflow.
  </Card>
  <Card title="Evals" icon="clipboard-check" href="/evals/overview">
    Build repeatable evaluation suites with `@m4trix/evals`.
  </Card>
</Columns>
