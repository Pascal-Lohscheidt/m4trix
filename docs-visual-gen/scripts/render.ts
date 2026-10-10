/**
 * Renders every scene (or the ids passed as args) to docs/images/visuals.
 *
 *   pnpm --filter docs-visual-gen render
 *   pnpm --filter docs-visual-gen render fan-out --out ./tmp
 *
 * PNG scenes are screenshotted at `scale`x. GIF scenes are captured frame by frame by seeking
 * the paused anime.js timeline, then encoded with one global palette and frame-diff
 * transparency (unchanged pixels become transparent, which keeps files small).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { type Browser, chromium, type Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import { type SceneMeta, sceneManifest } from '../src/scenes/manifest';

// gifenc ships CommonJS only.
const { GIFEncoder, quantize } = gifenc;
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]) {
  const ids: string[] = [];
  let out = path.resolve(pkgDir, '../docs/images/visuals');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i]);
    else ids.push(argv[i]);
  }
  return { ids, out };
}

async function launchBrowser(): Promise<Browser> {
  // Prefer the locally installed Chrome so no Playwright browser download is needed.
  const executablePath = process.env.CHROME_PATH;
  return chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
}

async function openScene(browser: Browser, baseUrl: string, meta: SceneMeta, scale: number) {
  const context = await browser.newContext({
    viewport: { width: meta.width, height: meta.height },
    deviceScaleFactor: scale,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}?scene=${meta.id}&capture`);
  await waitForReady(page);
  return page;
}

async function waitForReady(page: Page) {
  await page.waitForFunction(() => window.__scene?.ready === true, null, { timeout: 15_000 });
}

const frameLocator = (page: Page) => page.locator('[data-frame]');

async function seek(page: Page, ms: number) {
  await page.evaluate((t) => {
    window.__scene?.seek(t);
  }, ms);
}

async function renderPng(page: Page, file: string) {
  await frameLocator(page).screenshot({ path: file, type: 'png' });
}

function decode(buffer: Buffer) {
  const png = PNG.sync.read(buffer);
  return {
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length),
    width: png.width,
    height: png.height,
  };
}

// 4x4 Bayer matrix, centred on 0. Ordered dithering is position-stable: a pixel that does not
// change between frames maps to the same palette index, so frame diffing still works.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => (v + 0.5) / 16 - 0.5,
);
const DITHER_AMPLITUDE = 7;

/**
 * Maps RGBA pixels to the exact nearest palette color (cached per 24-bit color).
 * gifenc's own applyPalette buckets colors to rgb565 first, which tints near-grays and
 * draws contour lines through the soft neumorphic shadows.
 */
function createPaletteMapper(palette: number[][], width: number) {
  const cache = new Int16Array(1 << 24).fill(-1);
  const nearest = (r: number, g: number, b: number) => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < palette.length; i++) {
      const [pr, pg, pb] = palette[i];
      // Perceptual-ish weights; green matters most for luminance.
      const distance = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  };
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  return (rgba: Uint8Array) => {
    const out = new Uint8Array(rgba.length / 4);
    for (let p = 0; p < out.length; p++) {
      const x = p % width;
      const y = (p / width) | 0;
      const offset = BAYER[((y & 3) << 2) | (x & 3)] * DITHER_AMPLITUDE;
      const r = clamp(rgba[p * 4] + offset);
      const g = clamp(rgba[p * 4 + 1] + offset);
      const b = clamp(rgba[p * 4 + 2] + offset);
      const key = (r << 16) | (g << 8) | b;
      let index = cache[key];
      if (index < 0) {
        index = nearest(r, g, b);
        cache[key] = index;
      }
      out[p] = index;
    }
    return out;
  };
}

async function renderGif(page: Page, meta: SceneMeta & { output: { kind: 'gif' } }, file: string) {
  const { fps, durationMs, posterAtMs } = meta.output;
  const frameCount = Math.round((durationMs / 1000) * fps);
  const delay = 1000 / fps;
  const frame = frameLocator(page);

  const shots: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    await seek(page, i * delay);
    shots.push(await frame.screenshot({ type: 'png' }));
  }

  // One palette for the whole loop (sampled frames) avoids color flicker between frames.
  // 255 colors; the last index is reserved for "unchanged since the previous frame".
  const sampleEvery = Math.max(1, Math.floor(frameCount / 16));
  const samples = shots.filter((_, i) => i % sampleEvery === 0).map((s) => decode(s).data);
  const pooled = new Uint8Array(samples.reduce((n, s) => n + s.length, 0));
  samples.reduce((offset, s) => {
    pooled.set(s, offset);
    return offset + s.length;
  }, 0);
  const palette = quantize(pooled, 255, { format: 'rgb565' });
  const transparentIndex = palette.length;
  const fullPalette = [...palette, [0, 0, 0]];

  const { width, height } = decode(shots[0]);
  const toIndexed = createPaletteMapper(palette, width);
  const gif = GIFEncoder();
  let previous: Uint8Array | null = null;
  let pending: { index: Uint8Array; delay: number; first: boolean } | null = null;

  const flush = () => {
    if (!pending) return;
    gif.writeFrame(pending.index, width, height, {
      palette: pending.first ? fullPalette : undefined,
      delay: pending.delay,
      transparent: !pending.first,
      transparentIndex,
      dispose: 1,
      repeat: 0,
    });
  };

  for (const shot of shots) {
    const index = toIndexed(decode(shot).data);
    if (!previous) {
      pending = { index, delay, first: true };
      previous = index;
      continue;
    }
    const diff = new Uint8Array(index.length);
    let changed = false;
    for (let p = 0; p < index.length; p++) {
      if (index[p] === previous[p]) diff[p] = transparentIndex;
      else {
        diff[p] = index[p];
        changed = true;
      }
    }
    if (!changed && pending) {
      pending.delay += delay; // hold the previous frame longer instead of writing an empty one
      continue;
    }
    flush();
    pending = { index: diff, delay, first: false };
    previous = index;
  }
  flush();
  gif.finish();
  await writeFile(file, gif.bytes());

  // Static fallback / poster for places that can't autoplay GIFs. Reload first: seeking
  // backwards from the end of the loop does not restore state set by earlier tweens.
  await page.reload();
  await waitForReady(page);
  await seek(page, posterAtMs);
  await renderPng(page, file.replace(/\.gif$/, '.poster.png'));
}

async function main() {
  const { ids, out } = parseArgs(process.argv.slice(2));
  const scenes = ids.length ? sceneManifest.filter((s) => ids.includes(s.id)) : sceneManifest;
  const unknown = ids.filter((id) => !sceneManifest.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown scene(s): ${unknown.join(', ')}`);
  await mkdir(out, { recursive: true });

  const server = await createServer({
    root: pkgDir,
    configFile: path.join(pkgDir, 'vite.config.ts'),
    // No HMR socket: a dropped socket makes the client reload the page mid-capture.
    server: { port: 0, hmr: false, ws: false },
    logLevel: 'error',
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) throw new Error('Vite dev server did not report a URL');

  const browser = await launchBrowser();
  try {
    for (const meta of scenes) {
      const started = Date.now();
      const { output } = meta;
      if (output.kind === 'png') {
        const page = await openScene(browser, baseUrl, meta, output.scale);
        const file = path.join(out, `${meta.id}.png`);
        await renderPng(page, file);
        await page.context().close();
        console.log(`✓ ${meta.id}.png  (${Date.now() - started}ms)`);
      } else {
        const page = await openScene(browser, baseUrl, meta, 1);
        const file = path.join(out, `${meta.id}.gif`);
        await renderGif(page, { ...meta, output }, file);
        await page.context().close();
        console.log(`✓ ${meta.id}.gif + poster  (${Date.now() - started}ms)`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(`→ ${path.relative(process.cwd(), out) || out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
