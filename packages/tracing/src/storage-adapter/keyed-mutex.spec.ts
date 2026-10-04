import { describe, expect, it } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
  it('runs tasks for the same key one at a time, in call order', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const task = (label: string, delayMs: number) =>
      mutex.run('trace-1', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${label}`);
        await sleep(delayMs);
        events.push(`end:${label}`);
        active -= 1;
        return label;
      });

    await expect(Promise.all([task('a', 15), task('b', 1), task('c', 5)])).resolves.toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('runs tasks for different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      ['trace-1', 'trace-2'].map((key) =>
        mutex.run(key, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(5);
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(2);
  });

  it('releases the key when a task throws', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.run('trace-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(mutex.run('trace-1', async () => 'next')).resolves.toBe('next');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
