import { defineConfig, type ConfigType } from '@m4trix/evals';

export default defineConfig(
  (): ConfigType => ({
    discovery: {
      rootDir: 'src/evals',
      datasetFilePatterns: ['.dataset.ts'],
      evaluatorFilePatterns: ['.evaluator.ts'],
      testCaseFilePatterns: ['.test-case.ts'],
      excludeDirectories: ['node_modules', 'dist'],
    },
    artifactDirectory: 'src/evals/.eval-results',
    maxConcurrency: 2, // Run up to 4 test cases in parallel (default: 1)
  }),
);
