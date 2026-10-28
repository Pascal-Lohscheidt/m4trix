import { type AgentNetworkStore, AgentNetwork, type NetworkLogger } from '@m4trix/core';
import { modelAgent, stepCollector, toolRunner } from './agents.js';
import { DEFAULT_CONTEXT_BUDGET, defaultKeepTokens } from './context.js';
import {
  AssistantDelta,
  AssistantMessage,
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
  /**
   * Tokens of the newest conversation segments a compaction keeps verbatim (default: half the
   * context budget); the newest segment is always kept.
   */
  keepTokens?: number;
  consoleTracing?: boolean;
  logger?: NetworkLogger;
  /**
   * Where the conversation is kept: in memory by default; a session's file store
   * (`openSession(dir).store`, `--session`) keeps it on disk, so a restart continues it.
   */
  store?: AgentNetworkStore;
};

export function createCoderNetwork(options: CoderNetworkOptions) {
  const contextBudget = options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const model = modelAgent.produce({
    instructions: options.instructions,
    maxSteps: options.maxSteps,
    contextBudget,
    keepTokens: options.keepTokens ?? defaultKeepTokens(contextBudget),
  });

  return AgentNetwork.dependsOn([Model, Workspace]).setup(
    ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator, endsOn }) => {
      // The agent loop: tool calls out, results back, steps joined.
      const loop = createChannel('loop').events([ToolCallRequested, ToolResult, StepCompleted]);
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

      registerAgent(model).subscribe(mainChannel).subscribe(loop).publishTo(loop).publishTo(client);
      registerAgent(toolRunner).subscribe(loop).publishTo(loop).publishTo(client);
      registerAggregator(stepCollector).subscribe(loop).publishTo(loop);

      endsOn(AssistantMessage);
    },
    {
      // Each tool round trip is three hops (call → result → step-completed → next call), so the
      // default maxDepth of 25 would stop a turn after ~8 tool steps. maxSteps bounds a turn instead.
      // A compaction's checkpoint is a runtime event: it does not count against maxEvents.
      maxDepth: options.maxSteps * 3 + 10,
      maxEvents: options.maxSteps * 40,
      consoleTracing: options.consoleTracing,
      logger: options.logger,
      ...(options.store && { store: options.store }),
    },
  );
}
