import { describe, expect, it } from 'vitest';
import { parseTraceShipperCliArgs, TraceShipperCliParseError } from '../trace-shipper-args.js';
import { parseIntervalMs } from './run-loop.js';

describe('parseIntervalMs', () => {
  it('parses common duration strings', () => {
    expect(parseIntervalMs('500ms')).toBe(500);
    expect(parseIntervalMs('2s')).toBe(2000);
    expect(parseIntervalMs('1m')).toBe(60_000);
  });

  it('rejects invalid intervals', () => {
    expect(() => parseIntervalMs('nope')).toThrow('Invalid interval');
  });
});

describe('parseTraceShipperCliArgs', () => {
  it('defaults root and interval', () => {
    const prev = process.env.TRACE_ROOT;
    delete process.env.TRACE_ROOT;
    try {
      expect(parseTraceShipperCliArgs(['node', 'cli'])).toEqual({
        root: '/traces',
        interval: '2s',
        once: false,
      });
    } finally {
      if (prev === undefined) delete process.env.TRACE_ROOT;
      else process.env.TRACE_ROOT = prev;
    }
  });

  it('parses flags', () => {
    expect(parseTraceShipperCliArgs(['node', 'cli', '--root', './.traces', '--once'])).toEqual({
      root: './.traces',
      interval: '2s',
      once: true,
    });
  });

  it('throws help', () => {
    expect(() => parseTraceShipperCliArgs(['node', 'cli', '--help'])).toThrow(
      TraceShipperCliParseError,
    );
  });
});
