import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: ['@m4trix/core', '@m4trix/tracing'],
  },
  {
    entry: { 'server-entry': 'src/server-entry.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: ['@m4trix/core', '@m4trix/tracing'],
  },
]);
