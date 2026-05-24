import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: ['node18', 'es2020'],
  external: [
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-s3',
    '@aws-sdk/lib-dynamodb',
  ],
});
