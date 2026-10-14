import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/'],
      thresholds: {
        // `perFile` only applies to threshold sets that define numbers: there are no global ones,
        // so it makes every file matching a glob below meet the glob's thresholds on its own.
        perFile: true,
        // Context folds (@m4trix/core): all new code is fully covered, file by file.
        'packages/core/src/matrix/context/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
    //typecheck: {
    //  include: ['**/*.spec.ts', '**/*.spec-d.ts'],
    //},
  },
});
