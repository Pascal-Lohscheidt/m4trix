// @vitest-environment node
/**
 * `@m4trix/core` runs on Node 20+ and on Edge runtimes (Vercel Edge, Cloudflare Workers, Deno,
 * Bun): its runtime code imports nothing but `effect`, no Node built-ins. The built bundle is
 * checked the same way by `pnpm --filter @m4trix/core check:runtime` (see scripts/).
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  engines?: Record<string, string>;
  sideEffects?: unknown;
  browser?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports: Record<string, unknown>;
};

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || builtins.has(specifier.split('/')[0] ?? specifier);

describe('runtime support (Node 20+, Edge)', () => {
  test('the entry points bundle for a platform without Node built-ins', async () => {
    const result = await build({
      absWorkingDir: packageDir,
      entryPoints: ['src/index.ts', 'src/matrix/index.ts', 'src/testing/index.ts'],
      outdir: 'out',
      bundle: true,
      write: false,
      metafile: true,
      platform: 'neutral',
      format: 'esm',
      mainFields: ['module', 'main'],
      // The only runtime dependency, a peer dependency.
      external: ['effect', 'effect/*'],
      logLevel: 'silent',
    }).catch((error: { errors?: Array<{ text: string }> }) => {
      throw new Error(
        `bundling for a neutral platform failed: ${(error.errors ?? []).map((e) => e.text).join('; ')}`,
      );
    });

    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((i) => i.path),
    );
    expect(imports.filter(isBuiltin)).toEqual([]);
    // Nothing is left unbundled but effect.
    const external = [...new Set(imports.filter((path) => !path.startsWith('out/')))];
    expect(external).toContain('effect');
    expect(external.filter((path) => path !== 'effect' && !path.startsWith('effect/'))).toEqual([]);
  });
});

describe('package.json', () => {
  test('requires Node 20+', () => {
    expect(pkg.engines).toEqual({ node: '>=20' });
  });

  test('is side-effect free, without a browser field', () => {
    expect(pkg.sideEffects).toBe(false);
    expect(pkg).not.toHaveProperty('browser');
  });

  test('has effect as its only (peer) dependency', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(['effect']);
    expect(pkg.devDependencies).toHaveProperty('effect');
  });

  test('exports every entry point with types, import, require and default, and package.json', () => {
    for (const [subpath, dir] of [
      ['.', 'dist'],
      ['./matrix', 'dist/matrix'],
      ['./testing', 'dist/testing'],
    ] as const) {
      expect(pkg.exports[subpath], subpath).toEqual({
        import: { types: `./${dir}/index.d.ts`, default: `./${dir}/index.js` },
        require: { types: `./${dir}/index.d.cts`, default: `./${dir}/index.cjs` },
      });
    }
    expect(pkg.exports['./package.json']).toBe('./package.json');
  });
});
