import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  createFoldCache,
  DEFAULT_FOLD_CACHE_MAX_ENTRIES,
  DEFAULT_FOLD_CACHE_TTL,
  type FoldCache,
  type FoldCacheOptions,
  resolveFoldCacheOptions,
} from './fold-cache.js';

/** A clock the test moves by hand. */
const manualClock = (start = 1_000_000) => {
  let now = start;
  return {
    clock: { unsafeCurrentTimeMillis: () => now },
    advance: (millis: number) => {
      now += millis;
    },
  };
};

const MINUTE = 60_000;

/** Stores `value` under `id` (in `runId`, when given) and returns what was cached before. */
const put = <V>(cache: FoldCache<V>, id: string, value: V | undefined, runId?: string) =>
  cache.update({ id, ...(runId !== undefined && { runId }) }, async (entry) => ({
    entry: value,
    result: entry,
  }));

/** What is cached under `id`, leaving it in place. */
const peek = <V>(cache: FoldCache<V>, id: string) =>
  cache.update({ id }, async (entry) => ({ entry, result: entry }));

/** A promise with its resolve function, to hold an update open. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

describe('createFoldCache', () => {
  test('update stores the returned entry and resolves with the returned result', async () => {
    const cache = createFoldCache<number>();

    expect(await put(cache, 'a', 1)).toBeUndefined();
    expect(await put(cache, 'a', 2)).toBe(1);
    expect(await peek(cache, 'a')).toBe(2);
    expect(await peek(cache, 'b')).toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  test('an undefined entry removes the key', async () => {
    const cache = createFoldCache<number>();
    await put(cache, 'a', 1);

    await put(cache, 'a', undefined);

    expect(await peek(cache, 'a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  describe('one update per key at a time', () => {
    test('a second update of the key waits for the first and sees its entry', async () => {
      const cache = createFoldCache<number>();
      const first = gate();
      const order: string[] = [];

      const a = cache.update({ id: 'k' }, async (entry) => {
        order.push(`first saw ${entry}`);
        await first.opened;
        return { entry: 1, result: 'first' };
      });
      const b = cache.update({ id: 'k' }, async (entry) => {
        order.push(`second saw ${entry}`);
        return { entry: (entry ?? 0) + 1, result: 'second' };
      });
      // Give the second update every chance to start early.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(order).toEqual(['first saw undefined']);

      first.open();
      expect(await Promise.all([a, b])).toEqual(['first', 'second']);
      expect(order).toEqual(['first saw undefined', 'second saw 1']);
      expect(await peek(cache, 'k')).toBe(2);
    });

    test('three queued updates run in call order', async () => {
      const cache = createFoldCache<string>();
      const first = gate();
      const append = (suffix: string) =>
        cache.update({ id: 'k' }, async (entry) => {
          if (suffix === 'a') await first.opened;
          return { entry: `${entry ?? ''}${suffix}`, result: undefined };
        });

      const updates = [append('a'), append('b'), append('c')];
      first.open();
      await Promise.all(updates);

      expect(await peek(cache, 'k')).toBe('abc');
    });

    test('updates of different keys do not wait for each other', async () => {
      const cache = createFoldCache<number>();
      const held = gate();

      const slow = cache.update({ id: 'slow' }, async () => {
        await held.opened;
        return { entry: 1, result: undefined };
      });
      // Resolves while the other key's update is still held open.
      expect(await put(cache, 'fast', 2)).toBeUndefined();
      expect(await peek(cache, 'fast')).toBe(2);

      held.open();
      await slow;
      expect(await peek(cache, 'slow')).toBe(1);
    });

    test('a failing update leaves the entry as it was and lets the next one run', async () => {
      const cache = createFoldCache<number>();
      await put(cache, 'k', 1);
      const failing = cache.update({ id: 'k' }, async () => {
        throw new Error('store down');
      });
      const next = peek(cache, 'k');

      await expect(failing).rejects.toThrow('store down');
      expect(await next).toBe(1);
    });
  });

  describe('ttl', () => {
    test('drops an entry ttl after its last use; every use extends it', async () => {
      const { clock, advance } = manualClock();
      const cache = createFoldCache<number>({ ttl: '10 minutes', clock });
      await put(cache, 'a', 1);

      advance(9 * MINUTE);
      expect(await peek(cache, 'a')).toBe(1);
      advance(9 * MINUTE);
      expect(await peek(cache, 'a')).toBe(1);
      advance(10 * MINUTE);
      expect(await peek(cache, 'a')).toBeUndefined();
    });

    test('expired entries are dropped when another key is stored', async () => {
      const { clock, advance } = manualClock();
      const cache = createFoldCache<number>({ ttl: '10 minutes', clock });
      await put(cache, 'old-1', 1);
      await put(cache, 'old-2', 2);
      advance(5 * MINUTE);
      await put(cache, 'recent', 3);
      advance(5 * MINUTE);

      await put(cache, 'new', 4);

      expect(cache.size()).toBe(2);
      expect(await peek(cache, 'recent')).toBe(3);
    });

    test('Infinity keeps entries until they are evicted', async () => {
      const { clock, advance } = manualClock();
      const cache = createFoldCache<number>({ ttl: Number.POSITIVE_INFINITY, clock });
      await put(cache, 'a', 1);

      advance(365 * 24 * 60 * MINUTE);

      expect(await peek(cache, 'a')).toBe(1);
    });
  });

  describe('maxEntries', () => {
    test('evicts the least recently used entry once a new one goes over the cap', async () => {
      const cache = createFoldCache<number>({ maxEntries: 2 });
      await put(cache, 'a', 1);
      await put(cache, 'b', 2);
      // Using `a` makes `b` the least recently used.
      await peek(cache, 'a');

      await put(cache, 'c', 3);

      expect(cache.size()).toBe(2);
      expect(await peek(cache, 'b')).toBeUndefined();
      expect(await peek(cache, 'a')).toBe(1);
    });

    test('Infinity has no cap', async () => {
      const cache = createFoldCache<number>({ maxEntries: Number.POSITIVE_INFINITY });
      for (let i = 0; i < 2_000; i++) await put(cache, `k${i}`, i);

      expect(cache.size()).toBe(2_000);
    });
  });

  describe('dropRun', () => {
    test('removes the entries of the run only', async () => {
      const cache = createFoldCache<string>();
      await put(cache, 'run-a/steps', 'a1', 'run-a');
      await put(cache, 'run-a/tools', 'a2', 'run-a');
      await put(cache, 'run-b/steps', 'b1', 'run-b');
      await put(cache, 'ctx/conversation', 'c');

      cache.dropRun('run-a');

      expect(cache.size()).toBe(2);
      expect(await peek(cache, 'run-a/steps')).toBeUndefined();
      expect(await peek(cache, 'run-b/steps')).toBe('b1');
      expect(await peek(cache, 'ctx/conversation')).toBe('c');
    });

    test('an unknown run and a run whose entries are gone are no-ops', async () => {
      const cache = createFoldCache<string>({ maxEntries: 1 });
      await put(cache, 'run-a/steps', 'a', 'run-a');
      // Evicted: the run's index entry goes with it.
      await put(cache, 'run-b/steps', 'b', 'run-b');
      await put(cache, 'run-b/steps', undefined, 'run-b');

      cache.dropRun('run-a');
      cache.dropRun('run-b');
      cache.dropRun('unknown');

      expect(cache.size()).toBe(0);
    });

    test('an entry stored again under the same key keeps one index entry', async () => {
      const cache = createFoldCache<string>();
      await put(cache, 'run-a/steps', 'a1', 'run-a');
      await put(cache, 'run-a/steps', 'a2', 'run-a');

      cache.dropRun('run-a');

      expect(cache.size()).toBe(0);
    });
  });

  describe('options', () => {
    test('defaults: 1000 entries, 30 minutes', () => {
      expect(DEFAULT_FOLD_CACHE_MAX_ENTRIES).toBe(1_000);
      expect(DEFAULT_FOLD_CACHE_TTL).toBe('30 minutes');
      expect(resolveFoldCacheOptions(undefined)).toEqual({
        maxEntries: 1_000,
        ttlMillis: 30 * MINUTE,
        clock: expect.objectContaining({ unsafeCurrentTimeMillis: expect.any(Function) }),
      });
    });

    test('the default clock is the system clock', async () => {
      const { clock } = resolveFoldCacheOptions({});
      const before = Date.now();
      const now = clock.unsafeCurrentTimeMillis();

      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(Date.now());
    });

    test.each([0, -1, 1.5, Number.NaN])('rejects maxEntries %s', (maxEntries) => {
      expect(() => createFoldCache({ maxEntries })).toThrow(
        /foldCache\.maxEntries must be a positive integer or Infinity/,
      );
    });

    test.each([0, -5, 'nonsense'])('rejects ttl %s', (ttl) => {
      expect(() =>
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
        createFoldCache({ ttl: ttl as any }),
      ).toThrow(/foldCache\.ttl must be a positive duration or Infinity/);
    });
  });

  test('types', () => {
    expectTypeOf<FoldCacheOptions>().toEqualTypeOf<{
      maxEntries?: number;
      ttl?: import('effect/Duration').DurationInput;
      clock?: { unsafeCurrentTimeMillis(): number };
    }>();
    const cache = createFoldCache<{ readonly state: number }>();
    expectTypeOf(cache.update<string>)
      .parameter(1)
      .returns.toEqualTypeOf<
        Promise<{
          readonly entry: { readonly state: number } | undefined;
          readonly result: string;
        }>
      >();
    expectTypeOf(cache.update<string>).returns.toEqualTypeOf<Promise<string>>();
  });
});
