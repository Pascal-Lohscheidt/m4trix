import type { BoundTool } from '@m4trix/core';
import { tool } from 'langchain';
import { z } from 'zod';

const toolInputSchemas = {
  webSearch: z.object({
    query: z.string().describe('Search query for current web information'),
  }),
  readWebPage: z.object({
    urls: z.array(z.string()).describe('URLs to extract full page content from'),
    query: z
      .string()
      .optional()
      .describe('Optional intent to rerank extracted chunks for relevance'),
  }),
  listDirectory: z.object({
    path: z.string().optional().describe('Directory path under the configured filesystem root'),
  }),
  readTextFile: z.object({
    path: z.string().describe('Text file path under the configured filesystem root'),
  }),
  writeTextFile: z.object({
    path: z.string().describe('Text file path under the configured filesystem root'),
    contents: z.string().describe('UTF-8 text contents to write'),
  }),
  fileExists: z.object({
    path: z.string().describe('File or directory path under the configured filesystem root'),
  }),
  listMemories: z.object({}),
  readMemory: z.object({
    id: z.string().describe('Memory id to read'),
  }),
  writeMemory: z.object({
    id: z.string().describe('Stable memory id'),
    title: z.string().describe('Short memory title'),
    content: z.string().describe('Memory content'),
  }),
  readSystemPrompt: z.object({}),
  writeSystemPrompt: z.object({
    contents: z.string().describe('New persisted system prompt contents'),
  }),
  listSubAgents: z.object({}),
  readSubAgent: z.object({
    id: z.string().describe('Sub-agent id to read'),
  }),
  writeSubAgent: z.object({
    id: z.string().describe('Stable sub-agent id'),
    name: z.string().describe('Sub-agent display name'),
    description: z.string().describe('Short sub-agent description'),
    systemPrompt: z.string().describe('Sub-agent system prompt'),
  }),
  spawnSubAgent: z.object({
    prompt: z
      .string()
      .describe(
        'Task prompt for the background sub-agent. It can use web, filesystem, and memory tools.',
      ),
  }),
  runCommand: z.object({
    command: z.string().describe('Shell command to run under agent-tmp'),
    reason: z
      .string()
      .optional()
      .describe('Short explanation shown in the CLI approval prompt (not a pre-approval step)'),
  }),
} as const;

type KnownToolName = keyof typeof toolInputSchemas;

type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

type ReadWebPageResult = {
  pages: { url: string; content: string }[];
  failed: { url: string; error: string }[];
};

type FileSystemEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
};

type MemoryRecord = {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
};

type SubAgentRecord = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  updatedAt: string;
};

function isKnownToolName(name: string): name is KnownToolName {
  return name in toolInputSchemas;
}

function formatWebSearchForLlm(output: { results: WebSearchResult[] }): string {
  if (output.results.length === 0) {
    return 'No web results were returned for this query. Try rephrasing the search or ask the user for more context.';
  }

  return output.results
    .map((r, index) => {
      const header = `${index + 1}. ${r.title}\n   URL: ${r.url}`;
      const snippet = r.content.trim() ? `\n   ${r.content.trim()}` : '';
      return header + snippet;
    })
    .join('\n\n');
}

function formatReadWebPageForLlm(output: ReadWebPageResult): string {
  const sections: string[] = [];

  for (const [index, page] of output.pages.entries()) {
    const excerpt = page.content.trim().slice(0, 6000);
    sections.push(
      `${index + 1}. ${page.url}\n${excerpt}${page.content.length > 6000 ? '\n[truncated]' : ''}`,
    );
  }

  if (output.failed.length > 0) {
    sections.push(
      `Failed URLs:\n${output.failed.map((f) => `- ${f.url}: ${f.error}`).join('\n')}`,
    );
  }

  if (sections.length === 0) {
    return 'No page content could be extracted from the given URLs.';
  }

  return sections.join('\n\n');
}

function formatEntries(entries: FileSystemEntry[]): string {
  if (entries.length === 0) {
    return 'Directory is empty.';
  }

  return entries.map((entry) => `- ${entry.type}: ${entry.path}`).join('\n');
}

function formatMemoryList(memories: MemoryRecord[]): string {
  if (memories.length === 0) {
    return 'No memories are stored.';
  }

  return memories
    .map((memory) => `- ${memory.id}: ${memory.title} (updated ${memory.updatedAt})`)
    .join('\n');
}

function formatSubAgentList(subAgents: SubAgentRecord[]): string {
  if (subAgents.length === 0) {
    return 'No sub-agent definitions are stored.';
  }

  return subAgents
    .map((subAgent) => `- ${subAgent.id}: ${subAgent.name} - ${subAgent.description}`)
    .join('\n');
}

function formatToolOutput(name: KnownToolName, output: unknown): string {
  if (name === 'webSearch') {
    return formatWebSearchForLlm(output as { results: WebSearchResult[] });
  }
  if (name === 'readWebPage') {
    return formatReadWebPageForLlm(output as ReadWebPageResult);
  }
  if (name === 'listDirectory') {
    return formatEntries((output as { entries: FileSystemEntry[] }).entries);
  }
  if (name === 'readTextFile') {
    const result = output as { path: string; content: string };
    const content = result.content.length > 12000 ? `${result.content.slice(0, 12000)}\n[truncated]` : result.content;
    return `File: ${result.path}\n\n${content}`;
  }
  if (name === 'writeTextFile') {
    const result = output as { path: string; written: boolean };
    return result.written ? `Wrote ${result.path}.` : `Did not write ${result.path}.`;
  }
  if (name === 'fileExists') {
    const result = output as { path: string; exists: boolean };
    return `${result.path}: ${result.exists ? 'exists' : 'does not exist'}`;
  }
  if (name === 'listMemories') {
    return formatMemoryList((output as { memories: MemoryRecord[] }).memories);
  }
  if (name === 'readMemory') {
    const memory = (output as { memory?: MemoryRecord }).memory;
    return memory ? `${memory.id}: ${memory.title}\n${memory.content}` : 'Memory not found.';
  }
  if (name === 'writeMemory') {
    const memory = (output as { memory: MemoryRecord }).memory;
    return `Saved memory ${memory.id}: ${memory.title}.`;
  }
  if (name === 'readSystemPrompt') {
    return (output as { systemPrompt: string }).systemPrompt;
  }
  if (name === 'writeSystemPrompt') {
    return (output as { written: boolean }).written
      ? 'Updated persisted system prompt.'
      : 'Did not update persisted system prompt.';
  }
  if (name === 'listSubAgents') {
    return formatSubAgentList((output as { subAgents: SubAgentRecord[] }).subAgents);
  }
  if (name === 'readSubAgent') {
    const subAgent = (output as { subAgent?: SubAgentRecord }).subAgent;
    return subAgent
      ? `${subAgent.id}: ${subAgent.name}\n${subAgent.description}\n\n${subAgent.systemPrompt}`
      : 'Sub-agent not found.';
  }
  if (name === 'writeSubAgent') {
    const subAgent = (output as { subAgent: SubAgentRecord }).subAgent;
    return `Saved sub-agent ${subAgent.id}: ${subAgent.name}.`;
  }
  if (name === 'spawnSubAgent') {
    const result = output as {
      taskId: string;
      status: 'completed' | 'failed';
      result: string;
      error?: string;
    };
    if (result.status === 'failed') {
      return `Sub-agent task ${result.taskId} failed: ${result.error ?? 'unknown error'}`;
    }
    return `Sub-agent task ${result.taskId} completed:\n\n${result.result}`;
  }
  if (name === 'runCommand') {
    const result = output as {
      approved: boolean;
      executed: boolean;
      command: string;
      exitCode?: number;
      stdout: string;
      stderr: string;
      error?: string;
    };
    if (!result.approved) {
      return `Command not approved: ${result.error ?? 'denied by user'}`;
    }
    if (!result.executed) {
      return `Command approved but not executed: ${result.error ?? 'unknown error'}`;
    }
    const sections = [`Command: ${result.command}`, `Exit code: ${result.exitCode ?? 'unknown'}`];
    if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
    if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
    if (result.error) sections.push(`note: ${result.error}`);
    return sections.join('\n\n');
  }
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

/** Wrap m4trix bound tools as LangChain tools for `createAgent`. */
export function toLangChainTools(boundTools: readonly BoundTool[]) {
  return boundTools.map((bound) => {
    const { name, description } = bound.schema;

    if (!isKnownToolName(name)) {
      throw new Error(`No LangChain zod schema registered for m4trix tool: ${name}`);
    }

    const schema = toolInputSchemas[name];

    return tool(
      async (input) => {
        const output = await bound.execute(input);
        return formatToolOutput(name, output);
      },
      { name, description, schema },
    );
  });
}
