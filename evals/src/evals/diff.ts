import { diffString } from 'json-diff';

/**
 * Options for customizing JSON diff output. Passed to logDiff, createDiffLogEntry, and printJsonDiff.
 * @see https://www.npmjs.com/package/json-diff
 */
export interface JsonDiffOptions {
  /** Include equal sections of the document, not just deltas */
  full?: boolean;
  /** Sort primitive values in arrays before comparing */
  sort?: boolean;
  /** Compare only keys, ignore value differences */
  keysOnly?: boolean;
  /** Always output these keys when their parent object has any diff (comma-separated or array) */
  outputKeys?: string | string[];
  /** Output only new/updated values (no - lines) */
  outputNewOnly?: boolean;
  /** Exclude these keys from comparison (comma-separated or array) */
  excludeKeys?: string | string[];
  /** Include unchanged values in output */
  keepUnchangedValues?: boolean;
  /** Round floats to this many decimals before comparing */
  precision?: number;
  /** Max ... elisions in a row before collapsing */
  maxElisions?: number;
}

function createDiffString(
  expected: unknown,
  actual: unknown,
  diffOptions?: JsonDiffOptions,
): string {
  const opts = { ...diffOptions, color: false };
  const result = diffString(expected, actual, opts);
  return typeof result === 'string' ? result : '';
}

export interface DiffLogEntry {
  type: 'diff';
  label?: string;
  expected: unknown;
  actual: unknown;
  diff: string;
}

export interface LogEntry {
  type: 'log';
  label?: string;
  message: string;
}

export type EvaluatorLogEntry = DiffLogEntry | LogEntry;

function formatLogMessage(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  if (msg instanceof Error) return msg.stack ?? msg.message;
  try {
    if (msg !== null && typeof msg === 'object') {
      return JSON.stringify(msg, null, 2);
    }
    return String(msg);
  } catch {
    return String(msg);
  }
}

/**
 * Creates a LogEntry for storage in run artifacts. Use for logging objects or text.
 */
export function createLogEntry(
  message: unknown,
  options?: { label?: string },
): LogEntry {
  return {
    type: 'log',
    label: options?.label,
    message: formatLogMessage(message),
  };
}

/**
 * Returns lines from a log entry for display.
 */
export function getLogLines(entry: LogEntry): string[] {
  return entry.message.split('\n');
}

export interface CreateDiffLogEntryOptions extends JsonDiffOptions {
  label?: string;
}

export interface PrintJsonDiffOptions extends JsonDiffOptions {
  /** Enable ANSI colors (default: true) */
  color?: boolean;
}

/**
 * Creates a DiffLogEntry for storage in run artifacts (plain text, no ANSI).
 */
export function createDiffLogEntry(
  expected: unknown,
  actual: unknown,
  options?: CreateDiffLogEntryOptions,
): DiffLogEntry {
  const { label, ...diffOpts } = options ?? {};
  const diff = createDiffString(expected, actual, diffOpts);
  return {
    type: 'diff',
    label,
    expected,
    actual,
    diff: diff || '(no differences)',
  };
}

/**
 * Returns the plain diff string. Use for storage or when applying colors separately.
 */
export function getDiffString(entry: DiffLogEntry): string {
  return entry.diff || '(no differences)';
}

/**
 * Returns lines from the diff, each with a type for color application.
 */
export function getDiffLines(entry: DiffLogEntry): Array<{ type: 'add' | 'remove' | 'context'; line: string }> {
  const raw = entry.diff || '(no differences)';
  return raw.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('-') && !trimmed.startsWith('---')) {
      return { type: 'remove' as const, line };
    }
    if (trimmed.startsWith('+') && !trimmed.startsWith('+++')) {
      return { type: 'add' as const, line };
    }
    return { type: 'context' as const, line };
  });
}

/**
 * Prints a colorized JSON diff between two values to stdout.
 * Useful in evaluators to show expected vs actual output differences.
 * @param expected - The expected/reference value (shown as removed with -)
 * @param actual - The actual value (shown as added with +)
 * @returns The diff string (also printed to console)
 */
export function printJsonDiff(
  expected: unknown,
  actual: unknown,
  options: PrintJsonDiffOptions = {},
): string {
  const { color = true, ...diffOpts } = options;
  const diff = createDiffString(expected, actual, diffOpts);
  if (color) {
    const lines = diff.split('\n').map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('-') && !trimmed.startsWith('---')) {
        return `\x1b[31m${line}\x1b[0m`;
      }
      if (trimmed.startsWith('+') && !trimmed.startsWith('+++')) {
        return `\x1b[32m${line}\x1b[0m`;
      }
      return line;
    });
    const colored = lines.join('\n');
    console.log(colored || '(no differences)');
    return colored;
  }
  console.log(diff || '(no differences)');
  return diff;
}
