/**
 * Evals example: runs one job via the runner API (not a discovered RunConfig file).
 *
 * Run from the evals-example directory:
 *   pnpm exec tsx src/index.ts
 *
 * Or use the CLI:
 *   eval-agents-simple run --run-config "example-name"
 *   eval-agents   (full TUI)
 */
import { createRunner, PROGRAMMATIC_RUN_CONFIG } from '@m4trix/evals';

async function runExample(): Promise<void> {
  const runner = createRunner();

  const dataset = await runner.resolveDatasetByName('demo-dataset');
  if (!dataset) {
    throw new Error('Demo Dataset not found');
  }

  const evaluators = await runner.resolveEvaluatorsByNamePattern('*Demo*');
  if (evaluators.length === 0) {
    throw new Error('No evaluators matched "*Demo*"');
  }

  console.log(
    `Running eval: dataset="${dataset.dataset.getName()}", evaluators=[${evaluators.map((e) => e.evaluator.getName()).join(', ')}]`,
  );

  const snapshot = await runner.runDatasetWith({
    datasetId: dataset.id,
    evaluatorIds: evaluators.map((e) => e.id),
    ...PROGRAMMATIC_RUN_CONFIG,
  });

  const done = new Promise<void>((resolve) => {
    const unsub = runner.subscribeRunEvents((event) => {
      if (event.type === 'RunCompleted') {
        console.log(`Completed: ${event.passedTestCases}/${event.totalTestCases} passed`);
        console.log(`Artifact: ${event.artifactPath}`);
        unsub();
        resolve();
      }
      if (event.type === 'RunFailed') {
        console.error(`Failed: ${event.errorMessage}`);
        unsub();
        resolve();
      }
    });
  });

  await done;
  await runner.shutdown();
}

void runExample().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Example failed');
  process.exit(1);
});
