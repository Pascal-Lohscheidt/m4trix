// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { parseCliArgs } from './args.js';
import { DEFAULT_CONTEXT_BUDGET } from './context.js';

describe('CLI arguments', () => {
  test('a leading -- (pnpm start -- …) is not an argument', () => {
    const argv = ['-p', 'fix it', '--yes', '--session', '/tmp/s', '--context-budget', '2000'];
    const expected = { print: 'fix it', yes: true, session: '/tmp/s', 'context-budget': '2000' };

    expect(parseCliArgs(['--', ...argv], {})).toMatchObject(expected);
    expect(parseCliArgs(argv, {})).toMatchObject(expected);
  });

  test('anything else that is not an option is still refused', () => {
    expect(() => parseCliArgs(['--', 'stray'], {})).toThrow(/Unexpected argument 'stray'/);
    expect(() => parseCliArgs(['--', '--', '-p', 'x'], {})).toThrow(/Unexpected argument/);
  });

  test('defaults: the model from M4TRIX_CODE_MODEL, the budget, no session', () => {
    expect(parseCliArgs([], { M4TRIX_CODE_MODEL: 'some-model' })).toMatchObject({
      model: 'some-model',
      yes: false,
      'max-steps': '60',
      'context-budget': String(DEFAULT_CONTEXT_BUDGET),
      trace: false,
      cwd: process.cwd(),
    });
    expect(parseCliArgs([], {})).toMatchObject({ model: 'gpt-5.4' });
    expect(parseCliArgs([], {}).session).toBeUndefined();
  });
});
