import { ParseResult } from 'effect';

/** One schema violation, located by a path such as `user.id` or `tags[1]` (`''` is the root). */
export type ToolIssue = { readonly path: string; readonly message: string };

/**
 * Thrown while defining a tool (`Tool.of()` … `define()`) when the definition can never be
 * sent to an LLM provider: an invalid name, an input schema without a JSON Schema
 * representation, or a non-object input schema. Failing here surfaces the problem at startup
 * instead of on the first model call.
 */
export class ToolDefinitionError extends Error {
  readonly _tag = 'ToolDefinitionError' as const;
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(message);
    this.name = 'ToolDefinitionError';
    this.toolName = toolName;
  }
}

/** The input (usually produced by a model) does not match the tool's input schema. */
export class ToolInputError extends Error {
  readonly _tag = 'ToolInputError' as const;
  readonly toolName: string;
  readonly issues: ReadonlyArray<ToolIssue>;

  constructor(toolName: string, issues: ReadonlyArray<ToolIssue>) {
    super(`Invalid input for tool "${toolName}":\n${formatIssueList(issues)}`);
    this.name = 'ToolInputError';
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** The tool's own output does not match its output schema: a bug in the tool, not the caller. */
export class ToolOutputError extends Error {
  readonly _tag = 'ToolOutputError' as const;
  readonly toolName: string;
  readonly issues: ReadonlyArray<ToolIssue>;

  constructor(toolName: string, issues: ReadonlyArray<ToolIssue>) {
    super(
      `Tool "${toolName}" returned output that does not match its output schema:\n` +
        formatIssueList(issues),
    );
    this.name = 'ToolOutputError';
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** The tool's `define` callback threw or rejected; `cause` is what it threw. */
export class ToolExecutionError extends Error {
  readonly _tag = 'ToolExecutionError' as const;
  readonly toolName: string;
  readonly cause: unknown;
  /** How many times the tool ran before giving up (more than 1 with `.retry()`). */
  readonly attempts: number;

  constructor(toolName: string, cause: unknown, attempts = 1) {
    super(`Tool "${toolName}" failed: ${describeCause(cause)}`);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.cause = cause;
    this.attempts = attempts;
  }
}

/** The tool did not finish within its `.timeout()`; its signal was aborted with this error. */
export class ToolTimeoutError extends Error {
  readonly _tag = 'ToolTimeoutError' as const;
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

function formatIssueList(issues: ReadonlyArray<ToolIssue>): string {
  return issues
    .map((issue) => `- ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
    .join('\n');
}

/** A thrown value's message, without its stack. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

/** Path-level issues of a schema decode failure. */
export function toToolIssues(error: ParseResult.ParseError): ReadonlyArray<ToolIssue> {
  return ParseResult.ArrayFormatter.formatErrorSync(error).map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/** Why a tool call failed, as reported to the model. */
export type ToolModelErrorKind = 'invalid_input' | 'execution_error' | 'timeout' | 'invalid_output';

/** A tool failure shaped for the model: a message it can act on, never a stack trace. */
export type ToolModelError = {
  readonly kind: ToolModelErrorKind;
  readonly message: string;
  /** Only for `invalid_input`: what to fix in the arguments. */
  readonly issues?: ReadonlyArray<ToolIssue>;
};

/** Result of `executeForModel`: feed it back to the model as the tool result. */
export type ToolModelResult<TOutput> =
  | { readonly ok: true; readonly output: TOutput }
  | { readonly ok: false; readonly error: ToolModelError };

/** Maps a typed tool error to its model-facing form; `undefined` for anything else. */
export function toToolModelError(error: unknown): ToolModelError | undefined {
  if (error instanceof ToolInputError) {
    return { kind: 'invalid_input', message: error.message, issues: error.issues };
  }
  if (error instanceof ToolExecutionError) {
    return { kind: 'execution_error', message: error.message };
  }
  if (error instanceof ToolTimeoutError) {
    return { kind: 'timeout', message: error.message };
  }
  if (error instanceof ToolOutputError) {
    // The issues quote the offending values; the model cannot fix them anyway.
    return {
      kind: 'invalid_output',
      message:
        `Tool "${error.toolName}" returned an invalid result. This is a bug in the tool, not in ` +
        'your input; retrying with different arguments will not help.',
    };
  }
  return undefined;
}
