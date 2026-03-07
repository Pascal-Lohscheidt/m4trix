import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.tsx',
    'cli-simple': 'src/cli-simple/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: ['node18', 'es2020'],
  external: ['ink', 'react', 'fullscreen-ink'],
});
