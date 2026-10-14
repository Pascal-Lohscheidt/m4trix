import { AgentNetwork, type NetworkLogger } from '@m4trix/core';
import { compactor, createModelAgent, stepCollector, toolRunner } from './agents.js';
import { createChatView, DEFAULT_CONTEXT_BUDGET, DEFAULT_KEEP_SEGMENTS } from './context.js';
import {
  AssistantDelta,
  AssistantMessage,
  CompactionRequested,
  ContextCompacted,
  ModelStep,
  PermissionRequested,
  PermissionResolved,
  StepCompleted,
  ToolCallRequested,
  ToolResult,
} from './events.js';
import { Model, Workspace } from './layers.js';

export type CoderNetworkOptions = {
  /** Project instructions (CLAUDE.md / AGENTS.md) appended to the system prompt. */
  instructions: string;
  /** Model steps (responses with tool calls) per turn before the agent is stopped. */
  maxSteps: number;
  /** Token budget of the conversation the model sees (default 100k); over it, it is compacted. */
  contextBudget?: number;
  /** Newest conversation segments a compaction keeps verbatim (default 4). */
  keepSegments?: number;
  consoleTracing?: boolean;
  logger?: NetworkLogger;
};

export function createCoderNetwork(options: CoderNetworkOptions) {
  const modelAgent = createModelAgent(
    createChatView(options.contextBudget ?? DEFAULT_CONTEXT_BUDGET),
  ).produce({
    instructions: options.instructions,
    maxSteps: options.maxSteps,
    keepSegments: options.keepSegments ?? DEFAULT_KEEP_SEGMENTS,
  });

  return AgentNetwork.dependsOn([Model, Workspace]).setup(
    ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator, endsOn }) => {
      // The agent loop: tool calls out, results back, steps joined; compaction on demand.
      const loop = createChannel('loop').events([
        ToolCallRequested,
        ToolResult,
        StepCompleted,
        CompactionRequested,
        ContextCompacted,
      ]);
      // What the terminal sees, and the permission answers it sends back.
      const client = createChannel('client')
        .proxy(proxy.sse())
        .events([
          AssistantDelta,
          ModelStep,
          ToolCallRequested,
          ToolResult,
          AssistantMessage,
          ContextCompacted,
          PermissionRequested,
          PermissionResolved,
        ]);

      registerAgent(modelAgent)
        .subscribe(mainChannel)
        .subscribe(loop)
        .publishTo(loop)
        .publishTo(client);
      registerAgent(toolRunner).subscribe(loop).publishTo(loop).publishTo(client);
      registerAgent(compactor).subscribe(loop).publishTo(loop).publishTo(client);
      registerAggregator(stepCollector).subscribe(loop).publishTo(loop);

      endsOn(AssistantMessage);
    },
    {
      // Each tool round trip is three hops (call → result → step-completed → next call), so the
      // default maxDepth of 25 would stop a turn after ~8 tool steps. maxSteps bounds a turn instead.
      // A compaction adds two events to the run (request and checkpoint).
      maxDepth: options.maxSteps * 3 + 10,
      maxEvents: options.maxSteps * 40,
      consoleTracing: options.consoleTracing,
      logger: options.logger,
    },
  );
}
