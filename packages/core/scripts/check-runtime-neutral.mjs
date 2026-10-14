// Checks that the built bundle runs without Node built-ins (Node 20+ and Edge runtimes: Vercel
// Edge, Cloudflare Workers, Deno, Bun). Run after `pnpm build`:
//
//   node scripts/check-runtime-neutral.mjs
//
// The ESM entry points are bundled for esbuild's `neutral` platform, which resolves no Node
// built-in; every entry point (ESM and CJS) is also scanned for built-in imports. `effect`, the
// only (peer) dependency, stays external.
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entries = ['dist/index', 'dist/matrix/index', 'dist/testing/index'];

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isBuiltin = (specifier) =>
  specifier.startsWith('node:') || builtins.has(specifier.split('/')[0]);
const isAllowed = (specifier) => specifier === 'effect' || specifier.startsWith('effect/');

const problems = [];

try {
  await build({
    absWorkingDir: packageDir,
    entryPoints: entries.map((entry) => `${entry}.js`),
    outdir: 'out',
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    mainFields: ['module', 'main'],
    external: ['effect', 'effect/*'],
    logLevel: 'silent',
  });
} catch (error) {
  for (const e of error.errors ?? [error]) problems.push(`neutral bundle: ${e.text ?? e.message}`);
}

const specifierPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
for (const entry of entries) {
  for (const file of [`${entry}.js`, `${entry}.cjs`]) {
    const source = readFileSync(join(packageDir, file), 'utf8');
    for (const [, specifier] of source.matchAll(specifierPattern)) {
      if (specifier.startsWith('.')) continue;
      if (isBuiltin(specifier)) problems.push(`${file}: imports the Node built-in "${specifier}"`);
      else if (!isAllowed(specifier)) problems.push(`${file}: imports "${specifier}"`);
    }
  }
}

if (problems.length > 0) {
  console.error(
    `The bundle is not runtime-neutral:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`runtime-neutral: ${entries.length} entry points import nothing but effect`);
