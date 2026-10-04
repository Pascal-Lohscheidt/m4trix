import { defineConfig, type Options } from 'tsup';

/**
 * The sidecar CLI as one self-contained file: the AWS SDK is bundled, so it runs without the
 * optional peer dependencies and the Docker image needs nothing but this file.
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
  banner: {
    // Bundled CommonJS dependencies call require() for Node built-ins.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
};

export default defineConfig(sidecarConfig);
