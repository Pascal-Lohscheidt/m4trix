import { Dataset, TagAndFilter, TagOrFilter } from '@m4trix/evals';

/**
 * Subset of demo cases: `(demo AND short) OR (demo AND long)`. Uses `TagOrFilter` / `TagAndFilter`
 * from `@m4trix/evals` (see `evaluateTagFilter`). Included as a run in `example-name.run-config.ts`.
 */
export const tagFilterDemoDataset = Dataset.define({
  name: 'tag-filter-demo',
  displayName: 'Tag filter: short OR long demo prompts',
  includedTags: TagOrFilter.of([
    TagAndFilter.of(['demo', 'short']),
    TagAndFilter.of(['demo', 'long']),
  ]),
});
