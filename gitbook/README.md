---
icon: chess-pawn-piece
---

# What is m4trix?

**m4trix** is a TypeScript library for building event-driven, type-safe AI agent networks — from a single agent to full multi-agent workflows, with built-in SSE streaming and framework adapters.

> **Alpha Release** — This project is in alpha. The API may change. Feedback welcome via [issues](https://github.com/Pascal-Lohscheidt/m4trix/issues) or [pascal@stepsailor.com](mailto:pascal@stepsailor.com).

## How are agents orchestrated?

**m4trix** consists of just a few components working together: a network with channels, actors, and events. Users interact with the network through events. An agent can trigger and listen to event&#x73;**.**

<figure><img src=".gitbook/assets/introduction 0.png" alt=""><figcaption></figcaption></figure>

<figure><img src=".gitbook/assets/introduction 1.png" alt=""><figcaption></figcaption></figure>

## Why all this event fiddling

Currently, most agentic frameworks are either designed for smaller workflows (e.g., a simple ReAct agent or a pipeline). Others, like langgraph, are designed for larger agent orchestration.&#x20;

#### The pain

You often start simple in agentic systems. A simple ReAct agent with some tools. Over time, you gain more requirements and skills that must work. You begin to engineer your way around these requirements. Tools become pipelines, agents turn into subgraphs, and you end up facing classic software design issues. The complexity gets out of hand.

You want reusability, not tightly coupled agents. You want strong typing. You want sections of agents that can be replaced with a new pattern. You also want to keep the code complexity manageable, even when your agent system has 60 different agents working on something.

## m4trix is great for you when...

* **Use it when** you have complicated multi-step agents.
* **Use it when** you want reliable production-grade agents.
* **Use it when** you prefer loose coupling and composability over rigid graph structures.

## When Not to Use m4trix

* **Avoid** if you just need a simple ReAct agent with a few tools.
* **Avoid** if you want to build agentic systems with drag-and-drop systems.

## Golden Paths

1. [**Install**](getting-started/install.md) — Get `@m4trix/core` and run your first agent in under 10 minutes.
2. [**Hello World**](getting-started/hello-world.md) — Copy/paste a minimal example and see it run.
3. [**Concepts: Events & Channels**](concepts/events.md) — Understand the mental model before building more.
