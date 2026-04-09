import { S, TestCase } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({ expectedMinScore: S.Number });

/** Shared tag so `sampledPoolDataset` picks these up; each has a distinct name for discovery. */
const poolTags = ['pool'] as const;

export const poolCaseAlpha = TestCase.describe({
  name: 'pool-alpha',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case alpha' },
  outputSchema,
  output: { expectedMinScore: 40 },
});

export const poolCaseBravo = TestCase.describe({
  name: 'pool-bravo',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case bravo' },
  outputSchema,
  output: { expectedMinScore: 42 },
});

export const poolCaseCharlie = TestCase.describe({
  name: 'pool-charlie',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case charlie' },
  outputSchema,
  output: { expectedMinScore: 44 },
});

export const poolCaseDelta = TestCase.describe({
  name: 'pool-delta',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case delta' },
  outputSchema,
  output: { expectedMinScore: 46 },
});

export const poolCaseEcho = TestCase.describe({
  name: 'pool-echo',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case echo' },
  outputSchema,
  output: { expectedMinScore: 48 },
});

export const poolCaseFoxtrot = TestCase.describe({
  name: 'pool-foxtrot',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case foxtrot' },
  outputSchema,
  output: { expectedMinScore: 50 },
});

export const poolCaseGolf = TestCase.describe({
  name: 'pool-golf',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case golf' },
  outputSchema,
  output: { expectedMinScore: 52 },
});

export const poolCaseHotel = TestCase.describe({
  name: 'pool-hotel',
  tags: [...poolTags],
  inputSchema,
  input: { prompt: 'Pool case hotel' },
  outputSchema,
  output: { expectedMinScore: 54 },
});
