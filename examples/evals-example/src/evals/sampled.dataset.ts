import { Dataset } from '@m4trix/evals';

/**
 * Narrower than `demo-dataset`: only test cases tagged `pool` (see `sampled.test-case.ts`).
 * Used in the example run config with `sampling` to run a random subset.
 */
export const sampledPoolDataset = Dataset.define({
  name: 'sampled-pool',
  displayName: 'Sampling pool',
  includedTags: ['pool'],
});
