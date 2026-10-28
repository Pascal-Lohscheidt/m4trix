import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledPackages, packageRootOf, sidecarSbom, writeSidecarSbom } from './sidecar-sbom.js';

describe('packageRootOf', () => {
  it('finds unscoped and scoped packages, also inside the pnpm store', () => {
    expect(packageRootOf('node_modules/tslib/tslib.es6.mjs')).toBe('node_modules/tslib');
    expect(
      packageRootOf(
        '../../node_modules/.pnpm/@aws-sdk+client-s3@3.1053.0/node_modules/@aws-sdk/client-s3/dist-es/index.js',
      ),
    ).toBe('../../node_modules/.pnpm/@aws-sdk+client-s3@3.1053.0/node_modules/@aws-sdk/client-s3');
  });

  it('uses the package root, not a nested package.json directory', () => {
    expect(packageRootOf('node_modules/@smithy/core/dist-es/submodules/cbor/index.js')).toBe(
      'node_modules/@smithy/core',
    );
  });

  it('skips first-party sources and malformed paths', () => {
    expect(packageRootOf('src/trace-shipper-cli.ts')).toBeUndefined();
    expect(packageRootOf('node_modules/')).toBeUndefined();
    expect(packageRootOf('node_modules/@scope')).toBeUndefined();
  });
});

describe('bundledPackages', () => {
  const manifests: Record<string, { name?: string; version?: string }> = {
    'node_modules/b': { name: 'b', version: '2.0.0' },
    'node_modules/.pnpm/b@1.0.0/node_modules/b': { name: 'b', version: '1.0.0' },
    'node_modules/@s/a': { name: '@s/a', version: '1.2.3' },
  };
  const read = (root: string) => manifests[root] ?? {};

  it('lists each package version once, sorted, from every input file', () => {
    expect(
      bundledPackages(
        [
          'src/index.ts',
          'node_modules/b/index.js',
          'node_modules/b/lib/util.js',
          'node_modules/.pnpm/b@1.0.0/node_modules/b/index.js',
          'node_modules/@s/a/dist/index.js',
        ],
        read,
      ),
    ).toEqual([
      { name: '@s/a', version: '1.2.3' },
      { name: 'b', version: '1.0.0' },
      { name: 'b', version: '2.0.0' },
    ]);
  });

  it('throws when a package root has no name or version', () => {
    expect(() => bundledPackages(['node_modules/c/index.js'], read)).toThrow(
      'node_modules/c/package.json has no name or version',
    );
  });
});

describe('sidecarSbom', () => {
  it('writes a CycloneDX document with npm package URLs', () => {
    const sbom = sidecarSbom([
      { name: '@aws-sdk/client-s3', version: '3.1053.0' },
      { name: 'tslib', version: '2.8.1' },
    ]);

    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1 });
    expect(sbom.metadata.component).toEqual({
      type: 'application',
      'bom-ref': 'm4trix-tracing-sidecar',
      name: 'm4trix-tracing-sidecar',
    });
    expect(sbom.components).toEqual([
      {
        type: 'library',
        'bom-ref': 'pkg:npm/%40aws-sdk/client-s3@3.1053.0',
        name: '@aws-sdk/client-s3',
        version: '3.1053.0',
        purl: 'pkg:npm/%40aws-sdk/client-s3@3.1053.0',
      },
      {
        type: 'library',
        'bom-ref': 'pkg:npm/tslib@2.8.1',
        name: 'tslib',
        version: '2.8.1',
        purl: 'pkg:npm/tslib@2.8.1',
      },
    ]);
  });
});

describe('writeSidecarSbom', () => {
  it('reads the esbuild metafile and the package manifests relative to the build directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidecar-sbom-'));
    mkdirSync(join(dir, 'node_modules/@s/a'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules/@s/a/package.json'),
      JSON.stringify({ name: '@s/a', version: '1.2.3' }),
    );
    writeFileSync(
      join(dir, 'metafile.json'),
      JSON.stringify({
        inputs: { 'src/cli.ts': {}, 'node_modules/@s/a/dist/index.js': {} },
        outputs: {},
      }),
    );

    writeSidecarSbom({
      cwd: dir,
      metafile: 'metafile.json',
      out: 'out/sbom.cdx.json',
    });

    const sbom = JSON.parse(readFileSync(join(dir, 'out/sbom.cdx.json'), 'utf-8'));
    expect(sbom.components.map((c: { purl: string }) => c.purl)).toEqual(['pkg:npm/%40s/a@1.2.3']);
  });
});
