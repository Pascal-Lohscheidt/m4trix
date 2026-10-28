/**
 * Property test of compaction: whatever the interleaving of appends, compactions (with their
 * checkpoints stored late and out of order), deletes of the context, checkpoints that cannot be
 * restored and stored events that no longer decode, a warm read and a cold read always equal a
 * reference model of the semantics: the newest usable checkpoint, then every event of the fold
 * after its `through` that decodes with its event's schema.
 *
 * Replies transform (`NumberFromString`): they are stored encoded, as the runtime appends them,
 * and decoded on read.
 *
 * Deterministic: fixed seeds of a fixed generator. Three stores: the in-memory one as it is, one
 * that hands out fresh (JSON-cloned) objects on every write and read, and one that returns a
 * different cursor string for the same position on every read (cursors are opaque).
 */
import { Either } from 'effect';
import { describe, expect, test } from 'vitest';
import { AgentNetworkEvent, type EnvelopeLike, S } from '../agent-network/agent-network-event.js';
import { createEventHistory } from '../agent-network/history.js';
import type {
  AgentNetworkStore,
  EventPage,
  ReadContextOptions,
  StoredEvent,
} from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import { ContextFold } from './context-fold.js';
import { createFoldCache } from './fold-cache.js';
import type { FoldCheckpointPayload } from './fold-checkpoint.js';
import { type CompactingFoldReader, createFoldReader, type FoldCacheEntry } from './fold-reader.js';

const UserPrompt = AgentNetworkEvent.of('user-prompt', S.Struct({ text: S.String }));
const Reply = AgentNetworkEvent.of('reply', S.Struct({ text: S.String, n: S.NumberFromString }));
const Other = AgentNetworkEvent.of('other', S.Struct({}));
const Log = ContextFold.of('log', { state: S.Array(S.String) })
  .initial(() => [])
  .on(UserPrompt, (lines, { payload }) => [...lines, `u:${payload.text}`])
  .on(Reply, (lines, { payload }) => [...lines, `r:${payload.text}+${payload.n + 1}`]);
const CHECKPOINT = 'm4trix:fold.checkpoint:log@1';
const key = { namespace: 'anonymous', contextId: 'ctx' };

const SEEDS = 400;
const STEPS = 80;

/** A linear congruential generator: the same seed, the same run. */
function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

type Variant = 'plain' | 'json-clone' | 'noncanonical-cursors';

/** The in-memory store as seen through `variant`, and the plain store underneath. */
function storeOf(variant: Variant) {
  const inner = createInMemoryNetworkStore({ ttl: Infinity, maxContexts: Infinity });
  const clone = <T>(value: T): T =>
    variant === 'json-clone' ? (JSON.parse(JSON.stringify(value)) as T) : value;
  let nonce = 0;
  /** The in-memory cursor behind a (tagged) cursor. */
  const plain = (cursor: string): string => cursor.split('#')[0] as string;
  const tag = (cursor: string | undefined): string | undefined =>
    cursor === undefined || variant !== 'noncanonical-cursors' ? cursor : `${cursor}#${++nonce}`;
  const store: AgentNetworkStore = {
    append: (storeKey, event) => inner.append(storeKey, clone(event)),
    readRun: async (storeKey, runId) => clone(await inner.readRun(storeKey, runId)),
    readContext: async (storeKey, options: ReadContextOptions = {}): Promise<EventPage> => {
      const page = await inner.readContext(storeKey, {
        ...options,
        ...(options.after !== undefined && { after: plain(options.after) }),
        ...(options.before !== undefined && { before: plain(options.before) }),
      });
      const head = tag(page.head);
      const cursor = tag(page.cursor);
      return clone({
        ...page,
        ...(head !== undefined && { head }),
        ...(cursor !== undefined && { cursor }),
      });
    },
    readLatest: async (storeKey, names) => {
      const latest = await (inner.readLatest as NonNullable<AgentNetworkStore['readLatest']>)(
        storeKey,
        names,
      );
      return latest && clone({ event: latest.event, cursor: tag(latest.cursor) as string });
    },
    deleteContext: (storeKey) =>
      (inner.deleteContext as NonNullable<AgentNetworkStore['deleteContext']>)(storeKey),
  };
  return { store, inner, plain };
}

/**
 * The reference semantics, from the whole stored history: the newest checkpoint (by append
 * order) that is usable (its state decodes; its `through` is null or a position in the current
 * history), then the fold's events after its `through`; without one, every event from the start.
 */
async function reference(inner: AgentNetworkStore, plain: (cursor: string) => string) {
  const page = await inner.readContext(key);
  const events = page.events;
  if (page.head === undefined) return [];
  const generation = Number(page.head.split(':')[0]);
  const fold = (state: readonly string[], from: number) => {
    const lines = [...state];
    for (const event of events.slice(from)) {
      if (event.name === 'user-prompt') lines.push(`u:${(event.payload as { text: string }).text}`);
      if (event.name !== 'reply') continue;
      // What no longer decodes is left out.
      const reply = S.decodeUnknownEither(Reply.payload)(event.payload);
      if (Either.isRight(reply)) lines.push(`r:${reply.right.text}+${reply.right.n + 1}`);
    }
    return lines;
  };
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as StoredEvent;
    if (event.name !== CHECKPOINT) continue;
    const { through, state } = event.payload as Partial<FoldCheckpointPayload>;
    if (!Array.isArray(state) || !state.every((line) => typeof line === 'string')) continue;
    if (through === null) return fold(state, 0);
    if (typeof through !== 'string') continue;
    const match = /^(\d+):(\d+)$/.exec(plain(through));
    // Of a deleted history, or not a cursor of this store at all: not usable.
    if (!match || Number(match[1]) !== generation) continue;
    return fold(state, Number(match[2]));
  }
  return fold([], 0);
}

/** Runs one seed; throws with the operations so far when a read differs from the reference. */
async function runSeed(seed: number, variant: Variant): Promise<void> {
  const random = generator(seed);
  const { store, inner, plain } = storeOf(variant);
  const history = createEventHistory(store, { runId: 'run', contextId: 'ctx' });
  let ids = 0;
  const meta = () => ({ runId: 'run', contextId: 'ctx', eventId: `e${++ids}` });
  // Compactions publish into `pending`; a later step appends one of them, in any order.
  const pending: StoredEvent[] = [];
  const reader = (): CompactingFoldReader =>
    createFoldReader({
      history,
      cache: {
        cache: createFoldCache<FoldCacheEntry>(),
        scope: { ...key, runId: 'run' },
        runActive: () => true,
      },
      publishCheckpoint: (checkpoint) => pending.push({ ...checkpoint, meta: meta() }),
    });
  const warm = reader();
  const compactors = [reader(), reader(), warm];
  const log: string[] = [];
  const check = async (step: number) => {
    const got = await warm(Log);
    const want = await reference(inner, plain);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(
        `seed ${seed} (${variant}), step ${step}: the warm read differs from the reference\n` +
          `got  ${JSON.stringify(got)}\nwant ${JSON.stringify(want)}\n${log.join('\n')}`,
      );
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const roll = random();
    if (roll < 0.35) {
      // Stored as the runtime stores it: the payload encoded with the event's schema.
      const event: EnvelopeLike =
        random() < 0.5
          ? UserPrompt.makeBound(meta(), { text: `${ids}` })
          : { name: 'reply', meta: meta(), payload: { text: `${ids}`, n: `${ids}` } };
      await store.append(key, event);
      log.push(`append ${event.name}`);
    } else if (roll < 0.38) {
      await store.append(key, { name: 'reply', meta: meta(), payload: { text: 'x', n: 'NaN?' } });
      log.push('append a reply that does not decode');
    } else if (roll < 0.42) {
      await store.append(key, Other.makeBound(meta(), {}));
      log.push('append other');
    } else if (roll < 0.55) {
      const compactor = compactors[
        Math.floor(random() * compactors.length)
      ] as CompactingFoldReader;
      await compactor.compact?.(Log, async (state) => ({
        state: [`S${(state as readonly string[]).length}@${ids}`],
      }));
      log.push('compact (checkpoint pending)');
    } else if (roll < 0.68) {
      if (pending.length === 0) continue;
      const [checkpoint] = pending.splice(Math.floor(random() * pending.length), 1);
      await store.append(key, checkpoint as StoredEvent);
      log.push(
        `append checkpoint through ${(checkpoint?.payload as FoldCheckpointPayload).through}`,
      );
    } else if (roll < 0.71) {
      await store.deleteContext?.(key);
      log.push('delete the context');
    } else if (roll < 0.73) {
      await store.append(key, {
        name: CHECKPOINT,
        meta: meta(),
        payload: { fold: 'log', version: 1, through: null, state: 42 },
      });
      log.push('append a checkpoint that does not decode');
    } else if (roll < 0.75) {
      await store.append(key, {
        name: CHECKPOINT,
        meta: meta(),
        payload: { fold: 'log', version: 1, through: 'pg:1234', state: ['foreign'] },
      });
      log.push('append a checkpoint with a foreign cursor');
    } else {
      await check(step);
      log.push('warm read');
    }
  }
  await check(STEPS);
  const cold = await reader()(Log);
  expect({ seed, variant, cold }).toEqual({ seed, variant, cold: await reference(inner, plain) });
}

describe('compaction: warm reads and cold reads always equal the reference semantics', () => {
  test.each<Variant>([
    'plain',
    'json-clone',
    'noncanonical-cursors',
  ])('%s store, %#', async (variant) => {
    for (let seed = 1; seed <= SEEDS; seed++) await runSeed(seed, variant);
  });
});
