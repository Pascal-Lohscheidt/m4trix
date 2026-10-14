import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'matrix/index': 'src/matrix/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // Node 20+ and Edge runtimes (web APIs only: no Node built-ins, see scripts/check-runtime-neutral.mjs).
  target: ['node20', 'es2022'],
});
