import { describe, expect, it } from 'vitest';
import { formatLatency, formatTimestamp, statusDotClass, statusTextClass } from './viewer';

describe('formatTimestamp', () => {
  it('formats parseable ISO timestamps', () => {
    const out = formatTimestamp('2026-06-17T09:30:05.000Z');
    expect(out).not.toBe('2026-06-17T09:30:05.000Z');
    expect(out).toMatch(/\d{2}.\d{2}.\d{2}/);
  });

  it('falls back to the raw value when unparseable', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('returns an empty string for missing values', () => {
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp('')).toBe('');
  });
});

describe('formatLatency', () => {
  it('uses milliseconds below one second', () => {
    expect(formatLatency(0)).toBe('0 ms');
    expect(formatLatency(412.6)).toBe('413 ms');
  });

  it('uses seconds below one minute', () => {
    expect(formatLatency(1234)).toBe('1.23 s');
    expect(formatLatency(12_345)).toBe('12.3 s');
  });

  it('uses minutes and seconds above one minute', () => {
    expect(formatLatency(125_000)).toBe('2m 5s');
  });
});

describe('status classes', () => {
  it('maps known statuses and falls back for in-flight ones', () => {
    expect(statusTextClass('success')).toContain('emerald');
    expect(statusTextClass('error')).toContain('rose');
    expect(statusTextClass('running')).toContain('amber');
    expect(statusDotClass('success')).toContain('bg-emerald-400');
    expect(statusDotClass('error')).toContain('bg-rose-400');
    expect(statusDotClass('pending')).toContain('bg-amber-300');
  });
});
