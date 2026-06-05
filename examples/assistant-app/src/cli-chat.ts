import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';
import type { AssistantClient } from './client/trpc.js';

type AgentEventChunk = {
  name: string;
  payload: unknown;
  meta: {
    runId: string;
    contextId: string;
    correlationId?: string;
  };
};

type ToolCallStatus = {
  toolCallId: string;
  toolName: string;
};

type RenderState = {
  assistantBlockStarted: boolean;
  answerStarted: boolean;
  activeTools: Map<string, ToolCallStatus>;
  spinnerFrame: number;
  spinnerTimer: NodeJS.Timeout | undefined;
};

const isInteractive = stdout.isTTY;
const useColor = isInteractive && process.env.NO_COLOR == null;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Indent for tool lines and streamed reply under the assistant block. */
const ASSISTANT_INDENT = '  ';

function color(code: number, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const style = {
  accent: (text: string) => color(36, text),
  dim: (text: string) => color(2, text),
  error: (text: string) => color(31, text),
  ok: (text: string) => color(32, text),
  warn: (text: string) => color(33, text),
  bold: (text: string) => color(1, text),
};

function getPayload(event: AgentEventChunk): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload != null
    ? (event.payload as Record<string, unknown>)
    : {};
}

function renderHeader(): void {
  stdout.write(
    `${style.bold(style.accent('m4trix assistant'))} ${style.dim('(/exit to quit, /new to reset)')}\n`,
  );
}

function clearToolLine(): void {
  if (!isInteractive) return;
  stdout.write('\r\u001b[2K');
}

function renderActiveToolLine(state: RenderState): void {
  if (!isInteractive || state.activeTools.size === 0 || state.answerStarted) return;

  const frame = spinnerFrames[state.spinnerFrame % spinnerFrames.length] ?? '*';
  const tools = [...state.activeTools.values()].map((tool) => tool.toolName).join(', ');
  clearToolLine();
  stdout.write(
    indented(`${style.accent(frame)} ${style.dim('tool')} ${style.warn(tools)} ${style.dim('running')}`),
  );
}

function startSpinner(state: RenderState): void {
  if (!isInteractive || state.spinnerTimer || state.answerStarted) return;

  state.spinnerTimer = setInterval(() => {
    state.spinnerFrame += 1;
    renderActiveToolLine(state);
  }, 120);
}

function stopSpinner(state: RenderState): void {
  if (!state.spinnerTimer) return;
  clearInterval(state.spinnerTimer);
  state.spinnerTimer = undefined;
}

function cleanupRenderState(state: RenderState): void {
  stopSpinner(state);
  clearToolLine();
}

/** Print the assistant section header once per reply (before tools or streamed text). */
function ensureAssistantBlock(state: RenderState): void {
  if (state.assistantBlockStarted) return;
  cleanupRenderState(state);
  state.assistantBlockStarted = true;
  stdout.write(`${style.bold(style.accent('assistant'))}\n`);
}

function indented(text: string): string {
  return `${ASSISTANT_INDENT}${text}`;
}

function renderAssistantPrefix(state: RenderState): void {
  if (state.answerStarted) return;
  ensureAssistantBlock(state);
  state.answerStarted = true;
  stdout.write(indented(`${style.dim('>')} `));
}

function renderToolEvent(event: AgentEventChunk, state: RenderState): void {
  const payload = getPayload(event);
  const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
  const phase = payload.phase;

  ensureAssistantBlock(state);

  if (!toolCallId) {
    stdout.write(
      indented(
        `${style.dim('tool')} ${style.warn(toolName)} ${style.dim(String(phase ?? 'event'))}\n`,
      ),
    );
    return;
  }

  if (phase === 'start') {
    state.activeTools.set(toolCallId, { toolCallId, toolName });

    if (!isInteractive) {
      stdout.write(
        indented(`${style.dim('tool')} ${style.warn(toolName)} ${style.dim('running...')}\n`),
      );
      return;
    }

    startSpinner(state);
    renderActiveToolLine(state);
    return;
  }

  const activeTool = state.activeTools.get(toolCallId);
  state.activeTools.delete(toolCallId);
  const resolvedToolName = activeTool?.toolName ?? toolName;
  const hasActiveTools = state.activeTools.size > 0;
  if (!hasActiveTools) {
    stopSpinner(state);
  }

  if (isInteractive && !state.answerStarted) {
    clearToolLine();
  }

  if (typeof payload.error === 'string') {
    const line = isInteractive
      ? `${style.error('✗')} ${style.warn(resolvedToolName)} ${style.error('failed')}: ${payload.error}`
      : `${style.dim('tool')} ${style.warn(resolvedToolName)} ${style.error('failed')}: ${payload.error}`;
    stdout.write(indented(`${line}\n`));
    if (hasActiveTools) {
      renderActiveToolLine(state);
    }
    return;
  }

  if (isInteractive) {
    stdout.write(indented(`${style.ok('✓')} ${style.warn(resolvedToolName)}\n`));
    if (hasActiveTools) {
      renderActiveToolLine(state);
    }
    return;
  }

  stdout.write(
    indented(`${style.dim('tool')} ${style.warn(resolvedToolName)} ${style.ok('done')}\n`),
  );
}

/** Visible width of content inside the approval box (after `│ `). */
const APPROVAL_INNER_WIDTH = 68;
const APPROVAL_BOX_RULE_LEN = 70;

/** Unix/Windows-ish paths for middle-ellipsis shortening. */
const FILE_PATH_RE =
  /(?:~\/[^\s'"`|;&<>{}()[\]]+|(?<![:\w])\/[\w.@~+:-]+(?:\/[\w.@~+:-]+)*|[A-Za-z]:[\\/][^\s'"`|;&<>{}()[\]]+|\.\.?\/[^\s'"`|;&<>{}()[\]]+)/g;

const MAX_PATH_SEGMENT_LEN = 52;

function shortenMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return text.slice(0, maxLen);
  const side = Math.floor((maxLen - 3) / 2);
  return `${text.slice(0, side)}...${text.slice(-side)}`;
}

function shortenPathsInText(text: string): string {
  return text.replace(FILE_PATH_RE, (match) =>
    match.length > MAX_PATH_SEGMENT_LEN ? shortenMiddle(match, MAX_PATH_SEGMENT_LEN) : match,
  );
}

function formatApprovalLine(plain: string, maxWidth = APPROVAL_INNER_WIDTH): string {
  return shortenMiddle(shortenPathsInText(plain), maxWidth);
}

function writeApprovalBoxLine(line: string): void {
  stdout.write(indented(`${style.dim('│')} ${line}`) + '\n');
}

function writeApprovalCommand(command: string): void {
  const lines = command.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const continuation = '   ';
    const prefix = i === 0 ? '$ ' : continuation;
    const budget = APPROVAL_INNER_WIDTH - prefix.length;
    const body = formatApprovalLine(lines[i] ?? '', budget);
    const display = i === 0 ? `${style.bold('$')} ${body}` : `${continuation}${body}`;
    writeApprovalBoxLine(display);
  }
}

function writeApprovalLabelledField(label: string, text: string): void {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const prefix = i === 0 ? label : ' '.repeat(label.length);
    const budget = APPROVAL_INNER_WIDTH - prefix.length;
    const body = formatApprovalLine(lines[i] ?? '', budget);
    const display = i === 0 ? `${style.dim(label)}${body}` : `${prefix}${body}`;
    writeApprovalBoxLine(display);
  }
}

async function handleCommandApproval(
  event: AgentEventChunk,
  state: RenderState,
  client: AssistantClient,
  rl: Interface,
): Promise<void> {
  cleanupRenderState(state);
  ensureAssistantBlock(state);

  const payload = getPayload(event);
  const command = typeof payload.command === 'string' ? payload.command : '';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const correlationId = event.meta.correlationId;

  if (!correlationId) {
    stdout.write(indented(`${style.error('command approval missing correlationId')}\n`));
    return;
  }

  stdout.write('\n');
  stdout.write(indented(`${style.warn('shell command approval required')}\n`));
  stdout.write(indented(style.dim(`┌${'─'.repeat(APPROVAL_BOX_RULE_LEN)}`)) + '\n');
  writeApprovalCommand(command);
  if (cwd) {
    writeApprovalLabelledField('cwd: ', cwd);
  }
  if (reason) {
    writeApprovalLabelledField('why: ', reason);
  }
  stdout.write(indented(style.dim(`└${'─'.repeat(APPROVAL_BOX_RULE_LEN)}`)) + '\n');
  stdout.write(
    indented(
      `${style.dim('Runs on the server under agent-tmp after you approve. Nothing executes until you answer.')}\n`,
    ),
  );

  const answer = await rl.question(indented(`${style.bold('Approve?')} ${style.dim('[y/N]')} `));
  const approved = /^y(es)?$/i.test(answer.trim());

  await client.control.resolveCommandApproval.mutate({
    runId: event.meta.runId,
    contextId: event.meta.contextId,
    correlationId,
    requestId,
    approved,
    denialReason: approved ? undefined : 'Denied in CLI',
  });

  stdout.write(
    indented(
      approved
        ? `${style.ok('approved')} ${style.dim('— executing on server…')}\n`
        : `${style.dim('denied')} ${style.dim('— command was not run')}\n`,
    ),
  );
}

function renderEvent(
  event: AgentEventChunk,
  state: RenderState,
  client: AssistantClient,
  rl: Interface,
): Promise<void> {
  if (event.name === 'tool-used') {
    renderToolEvent(event, state);
    return Promise.resolve();
  }

  if (event.name === 'command-approval-requested') {
    return handleCommandApproval(event, state, client, rl);
  }

  if (event.name !== 'message-stream-chunk') return Promise.resolve();

  const payload = getPayload(event);
  const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
  const isFinal = payload.isFinal === true;

  if (!isFinal && chunk) {
    renderAssistantPrefix(state);
    stdout.write(chunk);
  }
  if (isFinal) {
    if (!state.answerStarted) {
      renderAssistantPrefix(state);
    }
    stdout.write('\n');
  }
  return Promise.resolve();
}

export async function runChatRepl(client: AssistantClient): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let contextId = crypto.randomUUID();

  renderHeader();

  try {
    while (true) {
      const line = await rl.question(`${style.bold('you')} ${style.dim('>')} `);
      const text = line.trim();

      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/new') {
        contextId = crypto.randomUUID();
        stdout.write(`${style.ok('Started a new conversation.')}\n`);
        continue;
      }

      try {
        const events = await client.chat.send.mutate({ message: text, contextId });
        const renderState: RenderState = {
          assistantBlockStarted: false,
          answerStarted: false,
          activeTools: new Map(),
          spinnerFrame: 0,
          spinnerTimer: undefined,
        };

        try {
          for await (const event of events) {
            await renderEvent(event as AgentEventChunk, renderState, client, rl);
          }
        } finally {
          cleanupRenderState(renderState);
        }

        stdout.write('\n');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${style.error('error')} ${message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}
