import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { S, Tool } from '@m4trix/core';

import {
  CommandApprovalRequested,
  CommandApprovalResolved,
  ToolUsedEvent,
} from '../events.js';

const COMMAND_TIMEOUT_MS = 120_000;
const APPROVAL_TIMEOUT = '10 minutes';

function getAgentTmpCwd(): string {
  return resolve(process.cwd(), 'agent-tmp');
}

function runShellCommand(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      timeout: COMMAND_TIMEOUT_MS,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      });
    });
  });
}

export const runCommandTool = Tool.of({
  name: 'runCommand',
  description:
    'Run a shell command under the agent workspace (agent-tmp). Call this tool directly when a command is needed—the tool blocks and prompts the user in the CLI for approval before executing. Do not ask the user for permission in chat first. Returns stdout, stderr, and exit code (or a denial message if not approved).',
})
  .emits([ToolUsedEvent, CommandApprovalRequested])
  .input(
    S.Struct({
      command: S.String,
      reason: S.optional(S.String),
    }),
  )
  .output(
    S.Struct({
      requestId: S.String,
      approved: S.Boolean,
      executed: S.Boolean,
      command: S.String,
      cwd: S.String,
      exitCode: S.optional(S.Number),
      stdout: S.String,
      stderr: S.String,
      error: S.optional(S.String),
    }),
  )
  .define(async ({ input, emit, emitAndAwait, toolCallId }) => {
    const toolName = 'runCommand';
    const cwd = getAgentTmpCwd();
    const command = input.command.trim();

    emit(
      ToolUsedEvent.make({
        toolCallId,
        toolName,
        phase: 'start',
        input: { command, reason: input.reason },
      }),
    );

    try {
      if (!command) {
        throw new Error('Command must not be empty');
      }

      const reply = await emitAndAwait(
        CommandApprovalRequested.make({
          requestId: toolCallId,
          command,
          cwd,
          reason: input.reason,
        }),
        (event) =>
          CommandApprovalResolved.is(event) && event.payload.requestId === toolCallId,
        { timeout: APPROVAL_TIMEOUT },
      );

      if (!CommandApprovalResolved.is(reply)) {
        throw new Error('Approval reply did not match command-approval-resolved');
      }

      if (!reply.payload.approved) {
        const output = {
          requestId: toolCallId,
          approved: false,
          executed: false,
          command,
          cwd,
          stdout: '',
          stderr: '',
          error: reply.payload.denialReason ?? 'Command denied by user',
        };
        emit(ToolUsedEvent.make({ toolCallId, toolName, phase: 'end', output }));
        return output;
      }

      const { stdout, stderr, exitCode } = await runShellCommand(command, cwd);
      const output = {
        requestId: toolCallId,
        approved: true,
        executed: true,
        command,
        cwd,
        exitCode,
        stdout,
        stderr,
        error: exitCode === 0 ? undefined : `Command exited with code ${exitCode}`,
      };

      emit(ToolUsedEvent.make({ toolCallId, toolName, phase: 'end', output }));
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(
        ToolUsedEvent.make({
          toolCallId,
          toolName,
          phase: 'end',
          error: message,
        }),
      );
      throw error;
    }
  });
