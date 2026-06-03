import { agentMemoryTools } from './tools/agent-memory.tool.js';
import { fileSystemTools } from './tools/file-system.tool.js';
import { readWebPageTool } from './tools/read-web-page.tool.js';
import { runCommandTool } from './tools/run-command.tool.js';
import { spawnSubAgentTool } from './tools/spawn-sub-agent.tool.js';
import { webSearchTool } from './tools/web-search.tool.js';

/** Tools available to the main assistant and background sub-agents (excluding spawn). */
export const coreAssistantTools = [
  webSearchTool,
  readWebPageTool,
  ...fileSystemTools,
  ...agentMemoryTools,
] as const;

/** Full tool set for the main assistant, including background sub-agent delegation. */
export const mainAssistantTools = [
  ...coreAssistantTools,
  spawnSubAgentTool,
  runCommandTool,
] as const;
