import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DepedencyLayer, S } from '@m4trix/core';

const DEFAULT_SYSTEM_PROMPT = `# Assistant Memory

Use stored memories when they are relevant. Keep this file short and update it when long-lived guidance changes.
`;

export type AgentMemoryRecord = {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
};

export type AgentSubAgentRecord = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  updatedAt: string;
};

export type AgentMemorySnapshot = {
  systemPrompt: string;
  memories: AgentMemoryRecord[];
  subAgents: AgentSubAgentRecord[];
};

export type AgentMemoryAdapter = {
  init: () => Promise<void>;
  loadSystemPrompt: () => Promise<string>;
  writeSystemPrompt: (contents: string) => Promise<void>;
  listMemories: () => Promise<AgentMemoryRecord[]>;
  readMemory: (id: string) => Promise<AgentMemoryRecord | undefined>;
  writeMemory: (memory: Omit<AgentMemoryRecord, 'updatedAt'> & { updatedAt?: string }) => Promise<AgentMemoryRecord>;
  listSubAgents: () => Promise<AgentSubAgentRecord[]>;
  readSubAgent: (id: string) => Promise<AgentSubAgentRecord | undefined>;
  writeSubAgent: (
    subAgent: Omit<AgentSubAgentRecord, 'updatedAt'> & { updatedAt?: string },
  ) => Promise<AgentSubAgentRecord>;
  loadSnapshot: () => Promise<AgentMemorySnapshot>;
};

export const WithAgentMemoryLayer = DepedencyLayer.of({
  name: 'WithAgentMemoryLayer',
  config: S.Struct({ rootDir: S.String }),
}).define<AgentMemoryAdapter>();

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function ensureFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (!(await fileExists(path))) {
    await writeFile(path, contents, 'utf8');
  }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export class FsAgentMemoryAdapter implements AgentMemoryAdapter {
  readonly #rootDir: string;
  readonly #systemPromptPath: string;
  readonly #memoriesIndexPath: string;
  readonly #subAgentsIndexPath: string;

  constructor(options?: { rootDir?: string }) {
    this.#rootDir = resolve(options?.rootDir ?? process.cwd(), 'agent-tmp', 'memory');
    this.#systemPromptPath = resolve(this.#rootDir, 'system-prompt.md');
    this.#memoriesIndexPath = resolve(this.#rootDir, 'memories', 'index.json');
    this.#subAgentsIndexPath = resolve(this.#rootDir, 'sub-agents', 'index.json');
  }

  async init(): Promise<void> {
    await ensureFile(this.#systemPromptPath, DEFAULT_SYSTEM_PROMPT);
    await ensureFile(this.#memoriesIndexPath, '[]\n');
    await ensureFile(this.#subAgentsIndexPath, '[]\n');
  }

  async loadSystemPrompt(): Promise<string> {
    await this.init();
    return readFile(this.#systemPromptPath, 'utf8');
  }

  async writeSystemPrompt(contents: string): Promise<void> {
    await this.init();
    await writeFile(this.#systemPromptPath, contents, 'utf8');
  }

  async listMemories(): Promise<AgentMemoryRecord[]> {
    await this.init();
    return readJsonFile<AgentMemoryRecord[]>(this.#memoriesIndexPath, []);
  }

  async readMemory(id: string): Promise<AgentMemoryRecord | undefined> {
    const memories = await this.listMemories();
    return memories.find((memory) => memory.id === id);
  }

  async writeMemory(
    memory: Omit<AgentMemoryRecord, 'updatedAt'> & { updatedAt?: string },
  ): Promise<AgentMemoryRecord> {
    const memories = await this.listMemories();
    const nextMemory: AgentMemoryRecord = {
      ...memory,
      updatedAt: memory.updatedAt ?? new Date().toISOString(),
    };
    const nextMemories = [
      ...memories.filter((existingMemory) => existingMemory.id !== nextMemory.id),
      nextMemory,
    ].sort((a, b) => a.id.localeCompare(b.id));
    await writeJsonFile(this.#memoriesIndexPath, nextMemories);
    return nextMemory;
  }

  async listSubAgents(): Promise<AgentSubAgentRecord[]> {
    await this.init();
    return readJsonFile<AgentSubAgentRecord[]>(this.#subAgentsIndexPath, []);
  }

  async readSubAgent(id: string): Promise<AgentSubAgentRecord | undefined> {
    const subAgents = await this.listSubAgents();
    return subAgents.find((subAgent) => subAgent.id === id);
  }

  async writeSubAgent(
    subAgent: Omit<AgentSubAgentRecord, 'updatedAt'> & { updatedAt?: string },
  ): Promise<AgentSubAgentRecord> {
    const subAgents = await this.listSubAgents();
    const nextSubAgent: AgentSubAgentRecord = {
      ...subAgent,
      updatedAt: subAgent.updatedAt ?? new Date().toISOString(),
    };
    const nextSubAgents = [
      ...subAgents.filter((existingSubAgent) => existingSubAgent.id !== nextSubAgent.id),
      nextSubAgent,
    ].sort((a, b) => a.id.localeCompare(b.id));
    await writeJsonFile(this.#subAgentsIndexPath, nextSubAgents);
    return nextSubAgent;
  }

  async loadSnapshot(): Promise<AgentMemorySnapshot> {
    const [systemPrompt, memories, subAgents] = await Promise.all([
      this.loadSystemPrompt(),
      this.listMemories(),
      this.listSubAgents(),
    ]);
    return { systemPrompt, memories, subAgents };
  }
}

export function withAgentMemory(options?: { rootDir?: string }) {
  const adapter = new FsAgentMemoryAdapter(options);
  const rootDir = resolve(options?.rootDir ?? process.cwd(), 'agent-tmp', 'memory');

  return WithAgentMemoryLayer.make({
    config: { rootDir },
    init: () => adapter.init(),
    loadSystemPrompt: () => adapter.loadSystemPrompt(),
    writeSystemPrompt: (contents) => adapter.writeSystemPrompt(contents),
    listMemories: () => adapter.listMemories(),
    readMemory: (id) => adapter.readMemory(id),
    writeMemory: (memory) => adapter.writeMemory(memory),
    listSubAgents: () => adapter.listSubAgents(),
    readSubAgent: (id) => adapter.readSubAgent(id),
    writeSubAgent: (subAgent) => adapter.writeSubAgent(subAgent),
    loadSnapshot: () => adapter.loadSnapshot(),
  });
}
