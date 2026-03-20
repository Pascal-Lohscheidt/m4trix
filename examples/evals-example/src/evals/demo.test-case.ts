import { S, TestCase } from '@m4trix/evals';

const inputSchema = S.Struct({ prompt: S.String });
const outputSchema = S.Struct({
  expectedMinScore: S.Number,
  expectedResponse: S.optional(S.String),
});

export const shortPromptCase = TestCase.describe({
  name: 'Summarize product description for search',
  tags: ['demo', 'short'],
  inputSchema,
  input: { prompt: 'Hello from evals example' },
  outputSchema,
  output: { expectedMinScore: 40 },
});

export const diffExampleCase = TestCase.describe({
  name: 'Diff example: expected vs actual response',
  tags: ['demo', 'diff'],
  inputSchema,
  input: { prompt: 'What is the capital of France?' },
  outputSchema,
  output: {
    expectedMinScore: 50,
    expectedResponse: 'The capital of France is Paris.',
  },
});

export const diffMismatchCase = TestCase.describe({
  name: 'Diff example: mismatched structured output',
  tags: ['demo', 'diff'],
  inputSchema,
  input: { prompt: 'List the primary colors.' },
  outputSchema,
  output: {
    expectedMinScore: 50,
    expectedResponse: JSON.stringify({ colors: ['red', 'blue', 'yellow'] }),
  },
});

export const longPromptCase = TestCase.describe({
  name: 'Classify customer support ticket intent',
  tags: ['demo', 'long'],
  inputSchema,
  input: {
    prompt:
      'This is a longer fake prompt to demonstrate score differences in a tiny example project.',
  },
  outputSchema,
  output: { expectedMinScore: 55 },
});

export const greetingCase = TestCase.describe({
  name: 'Extract key entities from news article',
  tags: ['demo', 'greeting'],
  inputSchema,
  input: { prompt: 'Hey there!' },
  outputSchema,
  output: { expectedMinScore: 35 },
});

export const questionCase = TestCase.describe({
  name: 'Generate FAQ response for pricing',
  tags: ['demo', 'question'],
  inputSchema,
  input: { prompt: 'What is the weather like on Mars today?' },
  outputSchema,
  output: { expectedMinScore: 45 },
});

export const tinyPromptCase = TestCase.describe({
  name: 'Answer factual question about history',
  tags: ['demo', 'tiny'],
  inputSchema,
  input: { prompt: 'ok' },
  outputSchema,
  output: { expectedMinScore: 20 },
});

export const mediumPromptCase = TestCase.describe({
  name: 'Rewrite technical text for clarity',
  tags: ['demo', 'medium'],
  inputSchema,
  input: {
    prompt: 'Write a short summary about testing and observability in one sentence.',
  },
  outputSchema,
  output: { expectedMinScore: 50 },
});

export const storyPromptCase = TestCase.describe({
  name: 'Generate creative marketing headline',
  tags: ['demo', 'story'],
  inputSchema,
  input: {
    prompt:
      'Tell a creative story about a lighthouse keeper who tracks every storm in a detailed journal.',
  },
  outputSchema,
  output: { expectedMinScore: 60 },
});

export const codingPromptCase = TestCase.describe({
  name: 'Explain coding concept with examples',
  tags: ['demo', 'coding'],
  inputSchema,
  input: {
    prompt:
      'Explain the difference between unit tests, integration tests, and end-to-end tests with examples.',
  },
  outputSchema,
  output: { expectedMinScore: 65 },
});
