import { engine } from 'animejs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCursor } from './AiCursor.js';

/**
 * At the moment, the test setup is not very good.
 * We will write some basic tests to cover the most important functionality.
 */
describe('AiCursor', () => {
  beforeAll(() => {
    // anime.js normally ticks via requestAnimationFrame and pauses while `document.hidden`.
    // Both depend on how jsdom is set up on the host, which made this test pass locally but
    // never animate on CI. Drive the engine ourselves instead (see `tickUntil`).
    engine.useDefaultMainLoop = false;
    engine.pauseOnDocumentHidden = false;
  });

  afterAll(() => {
    engine.useDefaultMainLoop = true;
    engine.pauseOnDocumentHidden = true;
  });

  beforeEach(() => {
    window.document.body.innerHTML = '';
  });

  it('spawn() should create a new AiCursor instance', () => {
    expect(window.document.body.querySelectorAll('ai-cursor')).toHaveLength(0);

    AiCursor.spawn();

    const aiCursor = window.document.body.querySelector('ai-cursor');
    expect(aiCursor).not.toBeNull();
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

    // The move tween takes ~1s of wall-clock time; tick the engine until it lands.
    await vi.waitFor(
      () => {
        engine.update();
        const span = aiCursor?.shadowRoot?.querySelector('#cursor-graphic-parent');
        const match = span?.getAttribute('style')?.match(regex);
        expect(match).toBeTruthy();

        const [, translateX, translateY] = match as RegExpMatchArray;
        expect(Number(translateX)).toBeCloseTo(100);
        expect(Number(translateY)).toBeCloseTo(100);
      },
      { timeout: 8_000, interval: 16 },
    );
  });
});
