/**
 * Evals example: runs a single evaluation on the Demo Dataset.
 *
 * Run from the evals-example directory:
 *   pnpm exec tsx src/index.ts
 *
 * Or use the CLI directly:
 *   eval-agents-simple run --dataset "Demo Dataset" --evaluator "*Demo*"
 *   eval-agents   (full TUI - run multiple evals first to see bar charts and trend)
 */
import { createRunner } from '@m4trix/evals';

async function runExample(): Promise<void> {
  const runner = createRunner();

  const dataset = await runner.resolveDatasetByName('Demo Dataset');
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
