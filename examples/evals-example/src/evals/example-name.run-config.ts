import { RunConfig } from '@m4trix/evals';

import { demoDataset } from './demo.dataset';
import { demoScoreEvaluator } from './demo.evaluator';
import { sampledPoolDataset } from './sampled.dataset';
import { tagFilterDemoDataset } from './tag-filter.dataset';

/**
 * Representative RunConfig: concrete evaluators, a name pattern, and dataset sampling.
 *
 * CLI (from this package directory):
 *   eval-agents-simple run --run-config "example-name"
 */
export const exampleNameRunConfig = RunConfig.define({
  name: 'example-name',
  displayName: 'Example run config',
  runs: [
    { dataset: demoDataset, evaluators: [demoScoreEvaluator], repetitions: 10 },
    {
      dataset: tagFilterDemoDataset,
      evaluators: [demoScoreEvaluator],
      repetitions: 1,
    },
    { dataset: demoDataset, evaluatorPattern: '*Length*' },
    {
      dataset: sampledPoolDataset,
      evaluators: [demoScoreEvaluator],
      sampling: { count: 3, seed: 'evals-example-sampling' },
    },
  ],
});
