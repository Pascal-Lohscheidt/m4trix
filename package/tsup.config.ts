import { defineConfig } from 'tsup';

/*
--> removed for now - we don't want to ship them in the core package
    "./react": {
      "types": "./dist/react/index.d.ts",
      "import": "./dist/react/index.js",
      "require": "./dist/react/index.cjs",
      "default": "./dist/react/index.js"
    },
    "./ui": {
      "types": "./dist/ui/index.d.ts",
      "import": "./dist/ui/index.js",
      "require": "./dist/ui/index.cjs",
      "default": "./dist/ui/index.js"
    },
    "./api": {
      "types": "./dist/api/index.d.ts",
      "import": "./dist/api/index.js",
      "require": "./dist/api/index.cjs",
      "default": "./dist/api/index.js"
    },
 */

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    //'ui/index': 'src/ui/index.ts',
    'stream/index': 'src/stream/index.ts',
    //'react/index': 'src/react/index.ts',
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
  /**
   * SolidJS specific options - transform JSX to functions but in a way that's compatible
   * with external environments
  external: [
    'solid-js',
    'solid-js/web',
    'solid-js/jsx-runtime',
    'solid-js/store',
  ],

   
  esbuildOptions(options) {
    options.jsx = 'transform'; // Transform JSX to createElement calls
    options.jsxFactory = 'h';
    options.jsxImportSource = 'solid-js';
    options.platform = 'neutral'; // Support both browser and node
    return options;
  },
  */
  // Ensure we process CSS
  loader: {
    '.css': 'css',
  },
});
