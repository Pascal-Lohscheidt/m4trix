import { open, readFile, truncate } from 'node:fs/promises';
import type {
  AgentNetworkStore,
  AgentNetworkStoreKey,
  EventPage,
  ReadContextOptions,
  StoredEvent,
} from '@m4trix/core';

/**
 * A file-backed `AgentNetworkStore`: every event is one JSON line,
 * `{"namespace":…,"contextId":…,"event":{…}}`, appended to one file, so a session survives a
 * restart (`--session <dir>`). It passes core's `runStoreContract` (see `file-store.spec.ts`).
 *
 * - **Reads** come from memory: `openFileNetworkStore` loads the whole file once, and every read
 *   parses the stored JSON again, so it hands out fresh, unfrozen objects, as a database would.
 * - **Cursors** are `jsonl:<n>`, the point after the context's first `n` events. Lines are never
 *   rewritten, so a cursor stays valid across restarts (fold checkpoints persist them in
 *   `through`); a cursor of another format, or past the end of the history, reads as a reset.
 *   They carry no generation id (the in-memory store's do, so a cursor of a deleted history reads
 *   as a reset): that is only safe because nothing is ever deleted or rewritten here. A store
 *   that deletes contexts or rewrites the file must make cursors tell histories apart.
 * - **Durability:** an append resolves once its line is written and `fdatasync`ed. On macOS that
 *   reaches the drive, not necessarily its platters (no `F_FULLFSYNC`), and the directory entry
 *   of a new file is not synced: a crash of the process loses nothing acknowledged, a power loss
 *   may lose the last appends.
 * - **A torn last line** (a crash during an append) is dropped when the file is opened, and the
 *   file is truncated to the last whole line: a line counts once its newline is written. A
 *   malformed line before the last one is corruption, not a torn write: opening fails.
 * - **A failed append** may leave a torn line behind, so the store refuses further appends (the
 *   run fails with `store-error`); reopening it repairs the file.
 * - **One process per file.** Appends are serialized within the process; two processes appending
 *   to one file would not see each other's events. No `deleteContext`: delete the file to forget.
 */
export type FileNetworkStore = AgentNetworkStore & {
  /** The JSON lines file the store appends to. */
  readonly file: string;
};

/** What the store keeps in memory per event: enough to filter, and the JSON to hand out. */
type Entry = { readonly name: string; readonly runId: string; readonly json: string };

const keyOf = (namespace: string, contextId: string): string =>
  JSON.stringify([namespace, contextId]);

const CURSOR = /^jsonl:(\d+)$/;
const cursorAt = (position: number): string => `jsonl:${position}`;

/** A parsed line of the file, when it is one of an event; `undefined` otherwise. */
function parseLine(line: string): { key: string; entry: Entry } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const { namespace, contextId, event } = (parsed ?? {}) as {
    namespace?: unknown;
    contextId?: unknown;
    event?: { name?: unknown; meta?: { runId?: unknown } };
  };
  if (
    typeof namespace !== 'string' ||
    typeof contextId !== 'string' ||
    typeof event?.name !== 'string' ||
    typeof event.meta?.runId !== 'string'
  ) {
    return undefined;
  }
  return {
    key: keyOf(namespace, contextId),
    entry: { name: event.name, runId: event.meta.runId, json: JSON.stringify(event) },
  };
}

/**
 * Loads `file` (a missing file is an empty history) and returns a store that appends to it.
 * Rejects when a line before the last one is not an event line; drops (and truncates) a torn
 * last line.
 */
export async function openFileNetworkStore(file: string): Promise<FileNetworkStore> {
  const logs = new Map<string, Entry[]>();
  const logOf = (key: string): Entry[] => {
    let log = logs.get(key);
    if (!log) {
      log = [];
      logs.set(key, log);
    }
    return log;
  };

  const content = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const lines = content.split('\n');
  // The text after the last newline: empty, or a line whose append never finished.
  const torn = lines.pop() as string;
  for (const [index, line] of lines.entries()) {
    if (line === '') continue;
    const parsed = parseLine(line);
    if (!parsed) {
      throw new Error(
        `${file}:${index + 1}: not an event line of a file store; the file is corrupt.`,
      );
    }
    logOf(parsed.key).push(parsed.entry);
  }
  if (torn !== '') await truncate(file, Buffer.byteLength(content) - Buffer.byteLength(torn));

  // Appends are written one at a time, in call order, so positions only grow.
  let tail: Promise<unknown> = Promise.resolve();
  let failure: Error | undefined;

  const write = async (key: string, entry: Entry, line: string): Promise<void> => {
    if (failure) throw failure;
    try {
      const handle = await open(file, 'a');
      try {
        // A write may take only part of it (a short write): write the rest until it is all out.
        const bytes = Buffer.from(line);
        for (let offset = 0; offset < bytes.length; ) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
          if (bytesWritten <= 0) throw new Error('the write made no progress');
          offset += bytesWritten;
        }
        await handle.datasync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      failure = new Error(
        `${file}: an append failed (${(error as Error).message}); the file may end in a torn ` +
          'line, so reopen the store to continue.',
        { cause: error },
      );
      throw failure;
    }
    logOf(key).push(entry);
  };

  const parse = (entry: Entry): StoredEvent => JSON.parse(entry.json) as StoredEvent;

  /** The position a cursor of this store stands for; `undefined` for any other cursor. */
  const positionOf = (log: readonly Entry[], cursor: string): number | undefined => {
    const match = CURSOR.exec(cursor);
    const position = match ? Number(match[1]) : Number.NaN;
    return position <= log.length ? position : undefined;
  };

  const pageOf = (
    log: readonly Entry[],
    positions: readonly number[],
    more: boolean,
  ): EventPage => {
    const oldest = positions[0] as number;
    const newest = positions[positions.length - 1];
    return {
      events: positions.map((position) => parse(log[position] as Entry)),
      ...(more && { cursor: cursorAt(oldest) }),
      ...(newest !== undefined && { head: cursorAt(newest + 1) }),
    };
  };

  return {
    file,

    append: (key: AgentNetworkStoreKey, event: StoredEvent) => {
      const json = JSON.stringify(event);
      const line = `{"namespace":${JSON.stringify(key.namespace)},"contextId":${JSON.stringify(key.contextId)},"event":${json}}\n`;
      const entry: Entry = { name: event.name, runId: event.meta.runId, json };
      const appended = tail.then(() => write(keyOf(key.namespace, key.contextId), entry, line));
      tail = appended.catch(() => undefined);
      return appended;
    },

    readRun: async (key, runId) =>
      (logs.get(keyOf(key.namespace, key.contextId)) ?? [])
        .filter((entry) => entry.runId === runId)
        .map(parse),

    readContext: async (key, options: ReadContextOptions = {}): Promise<EventPage> => {
      const { limit, before, after, names } = options;
      if (after !== undefined && before !== undefined) {
        throw new Error('FileNetworkStore: readContext takes after or before, not both');
      }
      const log = logs.get(keyOf(key.namespace, key.contextId)) ?? [];
      const positions = log.flatMap((entry, position) =>
        names === undefined || names.includes(entry.name) ? [position] : [],
      );
      if (after !== undefined) {
        // Not a position in this history: read it from its start, flagged as a reset.
        const start = positionOf(log, after);
        const newer = positions.filter((position) => position >= (start ?? 0));
        const page = pageOf(log, limit === undefined ? newer : newer.slice(0, limit), false);
        return start === undefined ? { ...page, reset: true } : page;
      }
      const end = before === undefined ? log.length : positionOf(log, before);
      if (end === undefined) return { events: [] };
      const older = positions.filter((position) => position < end);
      const picked = limit === undefined ? older : older.slice(Math.max(0, older.length - limit));
      return pageOf(log, picked, picked.length < older.length);
    },
  };
}
