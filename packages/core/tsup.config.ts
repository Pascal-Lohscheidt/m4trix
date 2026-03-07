import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    //'api/index': 'src/api/index.ts',
    // 'helper/index': 'src/helper/index.ts', // uses @langchain/core
    'matrix/index': 'src/matrix/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: ['node18', 'es2020'],
});
