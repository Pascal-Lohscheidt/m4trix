/**
 * Writes the logo files the website serves.
 *
 *   pnpm --filter docs-visual-gen export:brand
 *   pnpm --filter docs-visual-gen export:brand --out ./tmp   (everything into one folder)
 *
 * - website/public/brand/*.svg  the mark (black, white, shades) and app icons, for anyone
 *                                who needs the logo as a file
 * - website/src/app/icon.svg, favicon.ico, apple-icon.png
 *                                picked up by Next's file conventions as the site's icons
 *
 * SVGs are rendered with react-dom/server; PNG / ICO are rasterized in Chrome (playwright-core,
 * like the scene renderer).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppIcon, PinwheelMark } from '../src/lib/brand/marks';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const single = outIndex > -1 ? path.resolve(process.argv[outIndex + 1]) : undefined;
const publicDir = single ?? path.resolve(pkgDir, '../website/public/brand');
const appDir = single ?? path.resolve(pkgDir, '../website/src/app');

const INK = { black: '#0b0b0e', white: '#ffffff' };

/**
 * Tuned for 16–48 px: the mark fills more of the tile and strokes are heavier. At 16 px the
 * gaps are widened so they survive as at least one clear pixel.
 */
const favicon = (size: number) =>
  size <= 16 ? (
    <AppIcon size={size} scale={0.84} weight={8.5} gap={19} radius={22} />
  ) : (
    <AppIcon size={size} scale={0.78} weight={9.5} radius={24} />
  );

const svgFiles: [dir: string, name: string, element: ReactElement][] = [
  [publicDir, 'm4trix-mark.svg', <PinwheelMark key="m" color={INK.black} />],
  [publicDir, 'm4trix-mark-white.svg', <PinwheelMark key="mw" color={INK.white} />],
  [publicDir, 'm4trix-mark-shades.svg', <PinwheelMark key="s" shades color={INK.black} />],
  [publicDir, 'm4trix-mark-shades-white.svg', <PinwheelMark key="sw" shades color={INK.white} />],
  [publicDir, 'm4trix-app-icon.svg', <AppIcon key="a" />],
  [publicDir, 'm4trix-app-icon-light.svg', <AppIcon key="al" tile={INK.white} ink={INK.black} />],
  [appDir, 'icon.svg', favicon(32)],
];

const svg = (element: ReactElement) => renderToStaticMarkup(element);

/** ICO with PNG-compressed entries (supported by every current browser). */
function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

await mkdir(publicDir, { recursive: true });
await mkdir(appDir, { recursive: true });
const written: string[] = [];

for (const [dir, name, element] of svgFiles) {
  await writeFile(path.join(dir, name), `${svg(element)}\n`);
  written.push(path.join(dir, name));
}

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
async function png(element: ReactElement, size: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(element)}`,
  );
  const data = await page.locator('svg').first().screenshot({ omitBackground: true });
  await page.close();
  return data;
}

try {
  const sizes = [16, 32, 48];
  const entries = [];
  for (const size of sizes) entries.push({ size, data: await png(favicon(size), size) });
  await writeFile(path.join(appDir, 'favicon.ico'), ico(entries));
  written.push(path.join(appDir, 'favicon.ico'));

  // iOS masks the corners itself, so the touch icon is full-bleed.
  await writeFile(
    path.join(appDir, 'apple-icon.png'),
    await png(<AppIcon size={180} radius={0} />, 180),
  );
  written.push(path.join(appDir, 'apple-icon.png'));
  for (const size of [192, 512]) {
    const name = `m4trix-app-icon-${size}.png`;
    await writeFile(path.join(publicDir, name), await png(<AppIcon size={size} />, size));
    written.push(path.join(publicDir, name));
  }
} finally {
  await browser.close();
}

for (const file of written) console.log(`✓ ${path.relative(process.cwd(), file)}`);
