import { rmSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';
import { writeSidecarSbom } from './src/sidecar-sbom.js';

/**
 * The sidecar CLI as one self-contained file: the AWS SDK is bundled, so it runs without the
 * optional peer dependencies and the Docker image needs nothing but this file.
 *
 * Next to it goes `trace-shipper-cli.cdx.json`, an SBOM of the npm packages inside the bundle, so
 * vulnerability scanners see them (see src/sidecar-sbom.ts).
 */
export const sidecarConfig: Options = {
  entry: { 'trace-shipper-cli': 'src/trace-shipper-cli.ts' },
  format: ['esm'],
  // .mjs so the bundle also runs outside this package (e.g. copied alone into the image).
  outExtension: () => ({ js: '.mjs' }),
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: false,
  treeshake: true,
  minify: false,
  target: 'node20',
  platform: 'node',
  noExternal: [/^@aws-sdk\//, /^@smithy\//, /^@aws-crypto\//, /^@aws\//],
  metafile: true,
  async onSuccess() {
    writeSidecarSbom({
      cwd: process.cwd(),
      metafile: 'dist/metafile-esm.json',
      out: 'dist/trace-shipper-cli.cdx.json',
    });
    // Only the SBOM is kept: the metafile would ship in the npm package.
    rmSync('dist/metafile-esm.json');
  },
  banner: {
    // Bundled CommonJS dependencies call require() for Node built-ins.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
};

export default defineConfig(sidecarConfig);
