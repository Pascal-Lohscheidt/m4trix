import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCursor } from './AiCursor.js';

/**
 * At the moment, the test setup is not very good.
 * We will write some basic tests to cover the most important functionality.
 */
describe('AiCursor', () => {
  beforeEach(() => {
    window.document.body.innerHTML = '';
  });

  it('spawn() should create a new AiCursor instance', () => {
    expect(window.document.body.querySelectorAll('ai-cursor')).toHaveLength(0);

    AiCursor.spawn();

    const aiCursor = window.document.body.querySelector('ai-cursor');
    expect(aiCursor).toBeDefined();
  });

  it('spawn() and move() the cursor to a position', { timeout: 10_000 }, async () => {
    const cursor = AiCursor.spawn();
    const aiCursor = window.document.body.querySelector('ai-cursor');
    expect(aiCursor).not.toBeNull();

    // The Lit element hooks up its callbacks after its first render.
    await vi.waitFor(() => {
      expect(aiCursor?.shadowRoot?.querySelector('#cursor-graphic-parent')).not.toBeNull();
    });
    cursor.moveTo([100, 100]);

    // since the mouse cursor uses css to animate the position, we need to check the styling in JSDom
    // it is questionable if this a very valuable test.

    //translateX(100px) translateY(100px)
    const regex = /translateX\(([^)]+)px\)\s+translateY\(([^)]+)px\)/;

    // The move tween takes ~1s; poll until it lands instead of racing a fixed sleep (flaky on CI).
    await vi.waitFor(
      () => {
        const span = aiCursor?.shadowRoot?.querySelector('#cursor-graphic-parent');
        const match = span?.getAttribute('style')?.match(regex);
        expect(match).not.toBeNull();
        expect(match).toBeDefined();

        const [, translateX, translateY] = match as RegExpMatchArray;
        expect(Number(translateX)).toBeCloseTo(100);
        expect(Number(translateY)).toBeCloseTo(100);
      },
      { timeout: 8_000, interval: 50 },
    );
  });
});
