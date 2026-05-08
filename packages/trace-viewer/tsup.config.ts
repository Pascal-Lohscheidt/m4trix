import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: ['@m4trix/tracing'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: ['@m4trix/tracing'],
  },
  {
    entry: { 'app/bundle': 'src/app/main.tsx' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'es2022',
    platform: 'browser',
    // Browser loads /assets/bundle.js as native ESM; bare specifiers must not remain.
    noExternal: ['react', 'react-dom', '@trpc/client', /@trpc\//],
    esbuildOptions(options) {
      options.define = {
        'process.env.NODE_ENV': '"production"',
      };
    },
  },
]);
