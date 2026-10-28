import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FileNetworkStore, openFileNetworkStore } from './file-store.js';

/**
 * A session directory (`--session <dir>`): the conversation survives the process.
 *
 * - `events.jsonl`: the network's store (`openFileNetworkStore`), every durable event of every
 *   conversation of the session, fold checkpoints included.
 * - `session.json`: `{ "contextId": … }`, the conversation the next start continues. `/clear`
 *   starts a new one; the old one stays in the store.
 *
 * One process per session at a time (see `FileNetworkStore`).
 */
export type Session = {
  readonly store: FileNetworkStore;
  /** The current conversation: its events are stored under this `contextId`. */
  readonly contextId: string;
  /** `true` when the directory held a session already: the conversation continues. */
  readonly resumed: boolean;
  /** Starts a new conversation in the same store, also for the next start; resolves to its id. */
  newContext(): Promise<string>;
};

/** Writes `session.json` whole or not at all: a crash leaves the old one. */
async function saveContextId(file: string, contextId: string): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ contextId })}\n`, { flush: true });
  await rename(temporary, file);
}

async function loadContextId(file: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let contextId: unknown;
  try {
    contextId = (JSON.parse(content) as { contextId?: unknown }).contextId;
  } catch {
    contextId = undefined;
  }
  if (typeof contextId !== 'string' || contextId === '') {
    throw new Error(`${file} is not an m4trix-code session (expected {"contextId": "…"}).`);
  }
  return contextId;
}

/** Opens the session in `dir` (created when missing), or starts one there. */
export async function openSession(dir: string): Promise<Session> {
  await mkdir(dir, { recursive: true });
  const sessionFile = join(dir, 'session.json');
  const stored = await loadContextId(sessionFile);
  const store = await openFileNetworkStore(join(dir, 'events.jsonl'));
  let contextId = stored ?? crypto.randomUUID();
  if (stored === undefined) await saveContextId(sessionFile, contextId);

  return {
    store,
    get contextId() {
      return contextId;
    },
    resumed: stored !== undefined,
    async newContext() {
      const next = crypto.randomUUID();
      await saveContextId(sessionFile, next);
      contextId = next;
      return next;
    },
  };
}
