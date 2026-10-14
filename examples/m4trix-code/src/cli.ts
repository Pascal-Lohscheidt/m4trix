#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type Envelope,
  type EventPlane,
  isRunEndEnvelope,
  RunLifecycleEvent,
  registerSSEStream,
} from '@m4trix/core';
import { Effect, Scope } from 'effect';
import {
  AssistantDelta,
  AssistantMessage,
  ContextCompacted,
  ModelStep,
  PermissionRequested,
  PermissionResolved,
  ToolCallRequested,
  ToolResult,
  UserPrompt,
} from './events.js';
import { DEFAULT_CONTEXT_BUDGET } from './context.js';
import { createOpenAIModel, createWorkspace } from './layers.js';
import { createCoderNetwork } from './network.js';

// The package's own .env (OPENAI_API_KEY, M4TRIX_CODE_MODEL); variables already set in the shell win.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values: args } = parseArgs({
  options: {
    print: { type: 'string', short: 'p' },
    cwd: { type: 'string', default: process.cwd() },
    model: { type: 'string', default: process.env.M4TRIX_CODE_MODEL ?? 'gpt-5.4' },
    yes: { type: 'boolean', short: 'y', default: false },
    'max-steps': { type: 'string', default: '60' },
    'context-budget': { type: 'string', default: String(DEFAULT_CONTEXT_BUDGET) },
    trace: { type: 'boolean', default: false },
  },
});

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function loadInstructions(root: string): Promise<string> {
  const files = ['CLAUDE.md', 'AGENTS.md', join('.claude', 'CLAUDE.md')];
  const found = await Promise.all(
    files.map((file) =>
      readFile(join(root, file), 'utf8').then(
        (content) => `# ${file}\n${content.trim()}`,
        () => undefined,
      ),
    ),
  );
  return found.filter(Boolean).join('\n\n');
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(color.red(`OPENAI_API_KEY is not set (add it to ${envFile} or the environment).`));
  process.exit(1);
}

const root = resolve(args.cwd);
const maxSteps = Number(args['max-steps']);
const contextBudget = Number(args['context-budget']);
if (!Number.isInteger(contextBudget) || contextBudget <= 0) {
  console.error(
    color.red(
      `--context-budget must be a positive integer (tokens), got "${args['context-budget']}".`,
    ),
  );
  process.exit(1);
}
const network = createCoderNetwork({
  instructions: await loadInstructions(root),
  maxSteps,
  contextBudget,
  consoleTracing: args.trace,
});
const layers = {
  Model: createOpenAIModel({ apiKey, model: args.model }),
  Workspace: createWorkspace(root),
};

/**
 * One plane for the whole session: its agents keep running between turns, and its store keeps the
 * conversation, so every turn of a session shares one context.
 */
function startPlane(): Promise<EventPlane> {
  return new Promise((resolvePlane, reject) => {
    const lifetime = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const plane = yield* network.run({ layers }).pipe(Effect.provideService(Scope.Scope, scope));
      resolvePlane(plane);
      yield* Effect.never;
    });
    Effect.runPromise(lifetime).catch(reject);
  });
}

const plane = await startPlane();
const session = network.expose(
  registerSSEStream({
    channel: 'client',
    plane,
    triggerEvents: [UserPrompt],
    layers,
    // A model call or a pending permission prompt counts as work in flight, not idle time.
    idleTimeout: '10 minutes',
    maxDuration: '2 hours',
    onRequest: ({ emitStartEvent, req, payload }) =>
      emitStartEvent({
        contextId: req.contextId ?? crypto.randomUUID(),
        runId: req.runId ?? crypto.randomUUID(),
        event: UserPrompt.make({ text: (payload as { text: string }).text }),
      }),
  }),
);

let rl: Interface | undefined;
const prompt = (question: string) => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question);
};

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

let atLineStart = true;
const write = (text: string) => {
  if (!text) return;
  process.stdout.write(text);
  atLineStart = text.endsWith('\n');
};
const line = (text = '') => {
  if (!atLineStart) write('\n');
  write(`${text}\n`);
};

function describeCall(name: string, rawArguments: string): string {
  try {
    const input = JSON.parse(rawArguments) as Record<string, unknown>;
    const main = input.command ?? input.path ?? input.pattern ?? '';
    const extra = name === 'grep' && input.path ? ` in ${input.path}` : '';
    return `${String(main).split('\n')[0].slice(0, 100)}${extra}`;
  } catch {
    return rawArguments.slice(0, 100);
  }
}

function preview(output: string, lines = 4): string {
  const all = output.trimEnd().split('\n');
  const shown = all.slice(0, lines).map((l) => l.slice(0, 160));
  const more = all.length > lines ? `\n     … +${all.length - lines} lines` : '';
  return shown.join('\n     ') + more;
}

async function answerPermission(
  envelope: Envelope,
  request: typeof PermissionRequested.payload.Type,
): Promise<void> {
  line(color.yellow(`  ? ${request.summary}`));
  if (request.tool !== 'bash') {
    for (const detailLine of request.detail.split('\n').slice(0, 40)) {
      line(
        detailLine.startsWith('+ ')
          ? color.green(`    ${detailLine}`)
          : detailLine.startsWith('- ')
            ? color.red(`    ${detailLine}`)
            : color.dim(`    ${detailLine}`),
      );
    }
  }

  let approved = args.yes;
  let reason: string | undefined;
  if (args.yes) {
    line(color.dim('    (auto-approved: --yes)'));
  } else {
    const answer = (await prompt(color.yellow('    Allow? [y/N/reason] '))).trim();
    approved = /^y(es)?$/i.test(answer);
    if (!approved && answer && !/^no?$/i.test(answer)) reason = answer;
    atLineStart = true;
  }

  await session.publish(
    PermissionResolved.make({ requestId: request.requestId, approved, reason }),
    {
      target: 'channel',
      meta: {
        runId: envelope.meta.runId,
        contextId: envelope.meta.contextId,
        correlationId: envelope.meta.correlationId,
      },
    },
  );
}

async function render(envelope: Envelope): Promise<'ok' | 'failed'> {
  if (AssistantDelta.is(envelope)) {
    write(envelope.payload.text);
  } else if (ModelStep.is(envelope) || AssistantMessage.is(envelope)) {
    if (!atLineStart) line();
  } else if (ToolCallRequested.is(envelope)) {
    const { name, arguments: rawArguments } = envelope.payload;
    line(`${color.cyan('⏺')} ${color.bold(name)}(${describeCall(name, rawArguments)})`);
  } else if (ToolResult.is(envelope)) {
    const { ok, output } = envelope.payload;
    const text = `  ⎿  ${preview(output)}`;
    line(ok ? color.dim(text) : color.red(text));
  } else if (ContextCompacted.is(envelope)) {
    const { summarized } = envelope.payload;
    if (summarized > 0) {
      const segments = `${summarized} segment${summarized === 1 ? '' : 's'}`;
      line(color.dim(`  ⎿  compacted ${segments} into a summary`));
    }
  } else if (PermissionRequested.is(envelope)) {
    await answerPermission(envelope, envelope.payload);
  } else if (isRunEndEnvelope(envelope)) {
    const usage = envelope.payload.usage;
    const tokens = usage
      ? ` · ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out tokens`
      : '';
    if (envelope.name === RunLifecycleEvent.failed) {
      const { error } = envelope.payload;
      line(color.red(`✗ turn failed (${error.kind}): ${error.message}`) + color.dim(tokens));
      return 'failed';
    }
    if (envelope.name === RunLifecycleEvent.cancelled) {
      line(color.yellow(`✗ turn cancelled (${envelope.payload.reason})`) + color.dim(tokens));
      return 'failed';
    }
    line(color.dim(`✓ done${tokens}`));
  }
  return 'ok';
}

// ---------------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------------

let contextId = crypto.randomUUID();
let activeTurn: AbortController | undefined;

async function runTurn(text: string): Promise<'ok' | 'failed'> {
  const controller = new AbortController();
  activeTurn = controller;
  try {
    return await session.createStream(
      {
        contextId,
        runId: crypto.randomUUID(),
        request: new Request('http://m4trix-code.local/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        }),
      },
      async (stream) => {
        let status: 'ok' | 'failed' = 'ok';
        for await (const envelope of stream) {
          if ((await render(envelope)) === 'failed') status = 'failed';
        }
        return status;
      },
    );
  } finally {
    activeTurn = undefined;
  }
}

process.on('SIGINT', () => {
  if (activeTurn) {
    activeTurn.abort();
    return;
  }
  process.exit(130);
});

line(color.dim(`m4trix-code · ${args.model} · ${root}`));

if (args.print !== undefined) {
  const status = await runTurn(args.print);
  process.exit(status === 'ok' ? 0 : 1);
}

while (true) {
  const text = (await prompt(color.bold('\n> '))).trim();
  atLineStart = true;
  if (!text) continue;
  if (text === '/exit' || text === '/quit') break;
  if (text === '/help') {
    line(color.dim('Commands: /clear, /help, /exit'));
    continue;
  }
  if (text === '/clear') {
    contextId = crypto.randomUUID();
    line(color.dim('Started a fresh conversation.'));
    continue;
  }
  await runTurn(text);
}
process.exit(0);
