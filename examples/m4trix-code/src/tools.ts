import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type EmitPayload, S, Tool, type ToolEmitAndAwaitFn } from '@m4trix/core';
import { PermissionRequested, PermissionResolved } from './events.js';
import { Workspace } from './layers.js';

const MAX_OUTPUT_CHARS = 30_000;
const PERMISSION_TIMEOUT = '30 minutes';

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} characters]`;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs?: number; shell?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      signal: options.signal,
      timeout: options.timeoutMs ?? 120_000,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolvePromise({ stdout, stderr, exitCode: code ?? (child.killed ? 124 : 1) }),
    );
  });
}

/**
 * Asks whoever answers `permission-requested` on the client channel (a human in the CLI, or an
 * auto-approve policy) and waits for the matching `permission-resolved`.
 */
async function requestPermission(
  emitAndAwait: ToolEmitAndAwaitFn<EmitPayload<typeof PermissionRequested>>,
  request: { tool: string; summary: string; detail: string },
): Promise<{ approved: boolean; reason?: string }> {
  const requestId = crypto.randomUUID();
  const reply = await emitAndAwait(
    PermissionRequested.make({ requestId, ...request }),
    (envelope) => PermissionResolved.is(envelope) && envelope.payload.requestId === requestId,
    { timeout: PERMISSION_TIMEOUT },
  );
  if (!PermissionResolved.is(reply)) return { approved: false, reason: 'unexpected reply' };
  return { approved: reply.payload.approved, reason: reply.payload.reason };
}

function denied(reason?: string): string {
  return `Permission denied by the user${reason ? `: ${reason}` : ''}. Do not retry the same action; ask the user how to proceed or choose a different approach.`;
}

export const readFileTool = Tool.of({
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns lines prefixed with their 1-based line number. Use offset/limit for large files.',
})
  .dependsOn(Workspace)
  .input(
    S.Struct({
      path: S.String,
      offset: S.optional(S.Number).annotations({ description: '1-based first line' }),
      limit: S.optional(S.Number).annotations({ description: 'Max lines (default 2000)' }),
    }),
  )
  .output(S.String)
  .define(async ({ input, layers }) => {
    const content = await readFile(layers.Workspace.resolve(input.path), 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, input.offset ?? 1);
    const end = Math.min(lines.length, start - 1 + (input.limit ?? 2000));
    const numbered = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
      .join('\n');
    const rest = end < lines.length ? `\n… ${lines.length - end} more lines` : '';
    return truncate(numbered + rest);
  });

export const writeFileTool = Tool.of({
  name: 'write_file',
  description:
    'Create or overwrite a file with the given content. Prefer edit_file for changes to existing files. Asks the user for permission.',
})
  .dependsOn(Workspace)
  .emits([PermissionRequested])
  .input(S.Struct({ path: S.String, content: S.String }))
  .output(S.String)
  .define(async ({ input, layers, emitAndAwait }) => {
    const target = layers.Workspace.resolve(input.path);
    const permission = await requestPermission(emitAndAwait, {
      tool: 'write_file',
      summary: `Write ${layers.Workspace.relative(target)}`,
      detail: truncate(input.content, 4000),
    });
    if (!permission.approved) return denied(permission.reason);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, 'utf8');
    return `Wrote ${input.content.split('\n').length} lines to ${layers.Workspace.relative(target)}`;
  });

export const editFileTool = Tool.of({
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Read the file first. Asks the user for permission.',
})
  .dependsOn(Workspace)
  .emits([PermissionRequested])
  .input(
    S.Struct({
      path: S.String,
      old_string: S.String,
      new_string: S.String,
      replace_all: S.optional(S.Boolean),
    }),
  )
  .output(S.String)
  .define(async ({ input, layers, emitAndAwait }) => {
    const target = layers.Workspace.resolve(input.path);
    const content = await readFile(target, 'utf8');
    const occurrences = content.split(input.old_string).length - 1;
    if (occurrences === 0) throw new Error(`old_string not found in ${input.path}`);
    if (occurrences > 1 && !input.replace_all) {
      throw new Error(
        `old_string occurs ${occurrences} times in ${input.path}; add context to make it unique or set replace_all`,
      );
    }

    const permission = await requestPermission(emitAndAwait, {
      tool: 'edit_file',
      summary: `Edit ${layers.Workspace.relative(target)}`,
      detail: truncate(
        `${input.old_string
          .split('\n')
          .map((l) => `- ${l}`)
          .join('\n')}\n${input.new_string
          .split('\n')
          .map((l) => `+ ${l}`)
          .join('\n')}`,
        4000,
      ),
    });
    if (!permission.approved) return denied(permission.reason);

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, () => input.new_string);
    await writeFile(target, updated, 'utf8');
    return `Edited ${layers.Workspace.relative(target)} (${input.replace_all ? occurrences : 1} replacement${occurrences > 1 && input.replace_all ? 's' : ''})`;
  });

/** `*` within a path segment, `**` across segments, `?` one character. */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      pattern += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export const listFilesTool = Tool.of({
  name: 'list_files',
  description:
    'List files in the workspace (git-tracked and untracked, respecting .gitignore), optionally filtered by a glob such as "src/**/*.ts".',
})
  .dependsOn(Workspace)
  .input(S.Struct({ pattern: S.optional(S.String) }))
  .output(S.String)
  .define(async ({ input, layers, signal }) => {
    const { stdout, stderr, exitCode } = await run(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: layers.Workspace.root, signal },
    );
    if (exitCode !== 0) throw new Error(`git ls-files failed: ${stderr}`);
    const matcher = input.pattern ? globToRegExp(input.pattern) : undefined;
    const files = stdout
      .split('\n')
      .filter((file) => file && (!matcher || matcher.test(file)));
    const shown = files.slice(0, 500);
    return files.length === 0
      ? 'No files match.'
      : `${shown.join('\n')}${files.length > shown.length ? `\n… ${files.length - shown.length} more` : ''}`;
  });

export const grepTool = Tool.of({
  name: 'grep',
  description:
    'Search file contents with an extended regular expression (git grep -E). Returns matching lines as path:line:text.',
})
  .dependsOn(Workspace)
  .input(
    S.Struct({
      pattern: S.String,
      path: S.optional(S.String).annotations({ description: 'Directory or file to search in' }),
      ignore_case: S.optional(S.Boolean),
    }),
  )
  .output(S.String)
  .define(async ({ input, layers, signal }) => {
    const args = ['grep', '-n', '-I', '--untracked', '-E'];
    if (input.ignore_case) args.push('-i');
    args.push('-e', input.pattern, '--', layers.Workspace.relative(input.path ?? '.'));
    const { stdout, stderr, exitCode } = await run('git', args, {
      cwd: layers.Workspace.root,
      signal,
    });
    if (exitCode === 1) return 'No matches.';
    if (exitCode !== 0) throw new Error(`git grep failed: ${stderr}`);
    return truncate(stdout, 15_000);
  });

export const bashTool = Tool.of({
  name: 'bash',
  description:
    'Run a shell command in the workspace root and return its exit code, stdout and stderr. Use for builds, tests and git. Asks the user for permission.',
})
  .dependsOn(Workspace)
  .emits([PermissionRequested])
  .input(
    S.Struct({
      command: S.String,
      timeout_ms: S.optional(S.Number).annotations({ description: 'Default 120000' }),
    }),
  )
  .output(S.String)
  .define(async ({ input, layers, emitAndAwait, signal }) => {
    const permission = await requestPermission(emitAndAwait, {
      tool: 'bash',
      summary: `Run: ${input.command}`,
      detail: input.command,
    });
    if (!permission.approved) return denied(permission.reason);
    const { stdout, stderr, exitCode } = await run(input.command, [], {
      cwd: layers.Workspace.root,
      signal,
      shell: true,
      timeoutMs: input.timeout_ms,
    });
    return truncate(
      `exit code: ${exitCode}\n${stdout ? `stdout:\n${stdout}\n` : ''}${stderr ? `stderr:\n${stderr}` : ''}`,
    );
  });

export const codingTools = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  grepTool,
  bashTool,
] as const;
