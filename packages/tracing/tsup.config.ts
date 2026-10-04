import { defineConfig } from 'tsup';
import { sidecarConfig } from './tsup.sidecar.config.js';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', aws: 'src/aws.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    target: ['node20', 'es2020'],
    platform: 'node',
    external: [
      '@aws-sdk/client-dynamodb',
      '@aws-sdk/client-s3',
      '@aws-sdk/lib-dynamodb',
      '@m4trix/core',
    ],
  },
  sidecarConfig,
]);
