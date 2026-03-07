import { describe, it, expect, beforeEach } from 'vitest';
import { AiCursor } from './AiCursor';

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

  it(
    'spawn() and move() the cursor to a position',
    async () => {
      const cursor = AiCursor.spawn();

      await new Promise((resolve) => setTimeout(resolve, 500));
      cursor.moveTo([100, 100]);

      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const aiCursor = window.document.body.querySelector('ai-cursor');
      expect(aiCursor).toBeDefined();

      const span = aiCursor?.shadowRoot?.querySelector(
        '#cursor-graphic-parent'
      );

      // since the mouse cursor uses css to animate the position, we need to check the styling in JSDom
      // it is questionable if this a very valuable test.

      //translateX(100px) translateY(100px)
      const regex = /translateX\(([^)]+)px\)\s+translateY\(([^)]+)px\)/;
      const match = span?.getAttribute('style')?.match(regex);
      expect(match).toBeDefined();

      const [, translateX, translateY] = match!;
      expect(translateX).toBeCloseTo(100);
      expect(translateY).toBeCloseTo(100);
    },
    {
      timeout: 10_000,
    }
  );
});
