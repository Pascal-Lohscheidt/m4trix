import { RunConfig } from '@m4trix/evals';

import { demoDataset } from './demo.dataset';
import { demoScoreEvaluator } from './demo.evaluator';

/**
 * Representative RunConfig: one run uses concrete evaluator exports, another uses a name pattern.
 *
 * CLI (from this package directory):
 *   eval-agents-simple run --run-config "example-name"
 */
export const exampleNameRunConfig = RunConfig.define({
  name: 'example-name',
  displayName: 'Example run config',
  runs: [
    { dataset: demoDataset, evaluators: [demoScoreEvaluator], repetitions: 10 },
    { dataset: demoDataset, evaluatorPattern: '*Length*' },
  ],
});
