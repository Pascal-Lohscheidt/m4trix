import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: ['node20', 'es2020'],
    platform: 'node',
    external: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3', '@aws-sdk/lib-dynamodb'],
  },
  {
    entry: { 'trace-shipper-cli': 'src/trace-shipper-cli.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    target: 'node20',
    platform: 'node',
    external: ['@aws-sdk/client-dynamodb', '@aws-sdk/client-s3', '@aws-sdk/lib-dynamodb'],
  },
]);
