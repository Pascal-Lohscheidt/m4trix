import { describe, expect, it } from 'vitest';
import { CliParseError, DEFAULT_FS_RELATIVE_PATH, DEFAULT_PORT, parseCliArgs } from './cli-args';

describe('parseCliArgs', () => {
  it('applies defaults', () => {
    expect(parseCliArgs(['node', 'cli'])).toEqual({
      command: 'serve',
      adapter: 'fs',
      path: DEFAULT_FS_RELATIVE_PATH,
      port: DEFAULT_PORT,
      mcp: true,
    });
  });

  it('parses --adapter fs and aws-stack', () => {
    expect(parseCliArgs(['node', 'cli', '--adapter', 'fs']).adapter).toBe('fs');
    expect(parseCliArgs(['node', 'cli', '--adapter', 'aws-stack']).adapter).toBe('aws-stack');
  });

  it('clears path for aws-stack', () => {
    expect(parseCliArgs(['node', 'cli', '--adapter', 'aws-stack', '--path', './x'])).toEqual({
      command: 'serve',
      adapter: 'aws-stack',
      path: undefined,
      port: DEFAULT_PORT,
      mcp: true,
    });
  });

  it('parses --path and --port', () => {
    expect(parseCliArgs(['node', 'cli', '--path', './tmp/foo', '--port', '9000'])).toEqual({
      command: 'serve',
      adapter: 'fs',
      path: './tmp/foo',
      port: 9000,
      mcp: true,
    });
  });

  it('rejects invalid adapter', () => {
    expect(() => parseCliArgs(['node', 'cli', '--adapter', 's3'])).toThrow(CliParseError);
  });

  it('rejects invalid port', () => {
    expect(() => parseCliArgs(['node', 'cli', '--port', '0'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['node', 'cli', '--port', 'abc'])).toThrow(CliParseError);
  });

  it('parses the mcp and serve commands with flags in any position', () => {
    expect(parseCliArgs(['node', 'cli', 'mcp', '--path', './tmp/foo'])).toEqual({
      command: 'mcp',
      adapter: 'fs',
      path: './tmp/foo',
      port: DEFAULT_PORT,
      mcp: true,
    });
    expect(parseCliArgs(['node', 'cli', '--adapter', 'aws-stack', 'mcp']).command).toBe('mcp');
    expect(parseCliArgs(['node', 'cli', 'serve']).command).toBe('serve');
  });

  it('disables the MCP endpoint with --no-mcp', () => {
    expect(parseCliArgs(['node', 'cli']).mcp).toBe(true);
    expect(parseCliArgs(['node', 'cli', '--no-mcp']).mcp).toBe(false);
  });

  it('rejects unknown commands', () => {
    expect(() => parseCliArgs(['node', 'cli', 'mpc'])).toThrow('Unknown command "mpc"');
  });

  it('throws HELP for --help', () => {
    expect(() => parseCliArgs(['node', 'cli', '--help'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['node', 'cli', '-h'])).toThrow(CliParseError);
  });
});
