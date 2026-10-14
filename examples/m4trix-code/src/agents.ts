import { AgentFactory, EventAggregator, S, toOpenAITools } from '@m4trix/core';
import {
  type ChatView,
  compactionMessages,
  completesStep,
  Conversation,
  needsCompaction,
  StepProgress,
  splitForCompaction,
  toChatMessages,
} from './context.js';
import {
  AssistantDelta,
  AssistantMessage,
  CompactionRequested,
  ContextCompacted,
  ModelStep,
  StepCompleted,
  ToolCallRequested,
  ToolResult,
  UserPrompt,
} from './events.js';
import { Model, Workspace } from './layers.js';
import { codingTools } from './tools.js';

function systemPrompt(root: string, instructions: string): string {
  return [
    'You are m4trix-code, a terminal coding agent. You help the user with software engineering tasks in their workspace.',
    `Workspace root: ${root}. All tool paths are relative to it.`,
    '',
    'How to work:',
    '- Explore before changing: use list_files, grep and read_file to understand the relevant code.',
    '- Make focused, minimal changes with edit_file (read the file first; old_string must match exactly). Use write_file only for new files.',
    '- Match the surrounding code style. Do not add unrelated changes.',
    '- Verify your work with bash (typecheck, tests) when the project offers a way to.',
    '- You may call several independent tools in one step.',
    '- When done, reply with a short summary of what you changed and how you verified it. No tool calls in that final reply.',
    instructions ? `\nProject instructions:\n${instructions}` : '',
  ].join('\n');
}

/** How long the model agent waits for the compactor's checkpoint. */
const COMPACTION_TIMEOUT = '5 minutes';

/**
 * Calls the model with the conversation's chat view; either answers (ends the turn) or asks for
 * tools. When the view no longer holds the whole conversation, it first has the compactor replace
 * the older part with a summary. Built per network: the view carries the CLI's token budget.
 */
export function createModelAgent(chatView: ChatView) {
  return AgentFactory.run()
    .params(S.Struct({ instructions: S.String, maxSteps: S.Number, keepSegments: S.Number }))
    .listensTo([UserPrompt, StepCompleted])
    .emits([AssistantDelta, ModelStep, ToolCallRequested, AssistantMessage, CompactionRequested])
    .dependsOn([Model, Workspace])
    .folds([chatView, StepProgress])
    .logic(async ({ params, emit, emitAndAwait, folds, layers, signal, reportUsage }) => {
      const { steps } = await folds.stepProgress();
      if (steps >= params.maxSteps) {
        emit(
          AssistantMessage.make({
            text: `Stopped: reached the limit of ${params.maxSteps} tool steps for one turn.`,
          }),
        );
        return;
      }

      // Includes the trigger and every tool result stored before it.
      let chat = await folds.chat();
      if (needsCompaction(chat, params.keepSegments)) {
        // The context is quiet: this is the only active agent (all results of the last step are
        // in), so nothing is published between the compactor's read and its checkpoint.
        await emitAndAwait(
          CompactionRequested.make({
            tokens: chat.tokens,
            budget: chat.budget,
            keep: params.keepSegments,
          }),
          ContextCompacted.is,
          { timeout: COMPACTION_TIMEOUT },
        );
        chat = await folds.chat(); // starts from the checkpoint
      }

      const response = await layers.Model.complete({
        messages: [
          { role: 'system', content: systemPrompt(layers.Workspace.root, params.instructions) },
          ...toChatMessages(chat.state),
        ],
        tools: toOpenAITools(codingTools),
        signal,
        onText: (text) => emit(AssistantDelta.make({ text })),
      });
      if (response.usage) reportUsage({ ...response.usage, model: layers.Model.model });

      if (response.toolCalls.length === 0) {
        emit(AssistantMessage.make({ text: response.text }));
        return;
      }

      const stepId = crypto.randomUUID();
      emit(ModelStep.make({ stepId, text: response.text, toolCalls: response.toolCalls }));
      for (const call of response.toolCalls) {
        emit(
          ToolCallRequested.make({
            stepId,
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            count: response.toolCalls.length,
          }),
        );
      }
    });
}

/**
 * Answers `compaction-requested` with a `context-compacted` checkpoint: the newest segments stay
 * verbatim, everything older (an earlier summary included) becomes one summary written by the
 * model. Reads the whole conversation, not the trimmed view.
 */
export const compactor = AgentFactory.run()
  .listensTo([CompactionRequested])
  .emits([ContextCompacted], { reply: true })
  .dependsOn(Model)
  .folds([Conversation])
  .logic(async ({ triggerEvent, emit, folds, layers, signal, reportUsage }) => {
    const conversation = await folds.conversation();
    const { older, kept } = splitForCompaction(conversation, triggerEvent.payload.keep);
    if (older.length === 0) {
      // Nothing to summarize: confirm the state as it is.
      emit(ContextCompacted.make({ summary: conversation.checkpoint ?? '', kept, summarized: 0 }));
      return;
    }

    const response = await layers.Model.complete({
      messages: compactionMessages(conversation.checkpoint, older),
      tools: [],
      signal,
      onText: () => {},
    });
    if (response.usage) reportUsage({ ...response.usage, model: layers.Model.model });
    emit(ContextCompacted.make({ summary: response.text.trim(), kept, summarized: older.length }));
  })
  .produce({});

/** Executes one tool call. Tool failures become results the model can read, never run failures. */
export const toolRunner = AgentFactory.run()
  .listensTo([ToolCallRequested])
  .emits([ToolResult])
  .tools(codingTools)
  .logic(async ({ triggerEvent, emit, tools, signal }) => {
    const { stepId, callId, name, arguments: rawArguments } = triggerEvent.payload;
    const result = (ok: boolean, output: string) =>
      emit(ToolResult.make({ stepId, callId, name, ok, output }));

    const tool = tools.toTools().find((candidate) => candidate.schema.name === name);
    if (!tool) return result(false, `Unknown tool "${name}".`);

    let input: unknown;
    try {
      input = rawArguments ? JSON.parse(rawArguments) : {};
    } catch {
      return result(false, `Arguments are not valid JSON: ${rawArguments}`);
    }

    const outcome = await tool.executeForModel(input, { toolCallId: callId, signal });
    if (outcome.ok) return result(true, String(outcome.output));
    const issues = outcome.error.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    result(
      false,
      `Error (${outcome.error.kind}): ${outcome.error.message}${issues ? ` [${issues}]` : ''}`,
    );
  })
  .produce({});

/** Joins a step's fan-out: once every tool call of a step has a result, it's the model's turn. */
export const stepCollector = EventAggregator.listensTo([ToolResult])
  .emits([StepCompleted])
  .folds([StepProgress])
  .emitWhen(async ({ triggerEvent, folds }) => {
    const { stepId, callId } = triggerEvent.payload;
    return completesStep(await folds.stepProgress(), stepId, callId);
  })
  .mapToEmit(({ triggerEvent, emit }) => {
    emit(StepCompleted.make({ stepId: triggerEvent.payload.stepId }));
  });
