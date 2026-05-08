import { describe, expect, it } from 'vitest';
import { CliParseError, DEFAULT_FS_RELATIVE_PATH, DEFAULT_PORT, parseCliArgs } from './cli-args';

describe('parseCliArgs', () => {
  it('applies defaults', () => {
    expect(parseCliArgs(['node', 'cli'])).toEqual({
      adapter: 'fs',
      path: DEFAULT_FS_RELATIVE_PATH,
      port: DEFAULT_PORT,
    });
  });

  it('parses --adapter fs and aws-stack', () => {
    expect(parseCliArgs(['node', 'cli', '--adapter', 'fs']).adapter).toBe('fs');
    expect(parseCliArgs(['node', 'cli', '--adapter', 'aws-stack']).adapter).toBe('aws-stack');
  });

  it('clears path for aws-stack', () => {
    expect(parseCliArgs(['node', 'cli', '--adapter', 'aws-stack', '--path', './x'])).toEqual({
      adapter: 'aws-stack',
      path: undefined,
      port: DEFAULT_PORT,
    });
  });

  it('parses --path and --port', () => {
    expect(parseCliArgs(['node', 'cli', '--path', './tmp/foo', '--port', '9000'])).toEqual({
      adapter: 'fs',
      path: './tmp/foo',
      port: 9000,
    });
  });

  it('rejects invalid adapter', () => {
    expect(() => parseCliArgs(['node', 'cli', '--adapter', 's3'])).toThrow(CliParseError);
  });

  it('rejects invalid port', () => {
    expect(() => parseCliArgs(['node', 'cli', '--port', '0'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['node', 'cli', '--port', 'abc'])).toThrow(CliParseError);
  });

  it('throws HELP for --help', () => {
    expect(() => parseCliArgs(['node', 'cli', '--help'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['node', 'cli', '-h'])).toThrow(CliParseError);
  });
});
