import { AgentFactory, ContextStrategy, EventAggregator, S, toOpenAITools } from '@m4trix/core';
import {
  ChatView,
  compactionChunks,
  compactionMessages,
  completesStep,
  Conversation,
  StepProgress,
  toChatMessages,
} from './context.js';
import {
  AssistantDelta,
  AssistantMessage,
  ContextCompacted,
  ModelStep,
  StepCompleted,
  ToolCallRequested,
  ToolResult,
  UserPrompt,
} from './events.js';
import { type ChatMessage, Model, type ModelTool, Workspace } from './layers.js';
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

/**
 * Calls the model with the chat view of the conversation, at the network's token budget; either
 * answers (ends the turn) or asks for tools. When the view no longer holds the whole conversation
 * within budget, it first compacts it: the model summarizes the older part (an earlier summary
 * included), the newest segments that fit `keepTokens` stay verbatim, always the newest one.
 */
export const modelAgent = AgentFactory.run()
  .params(
    S.Struct({
      instructions: S.String,
      maxSteps: S.Number,
      contextBudget: S.Number,
      keepTokens: S.Number,
    }),
  )
  .listensTo([UserPrompt, StepCompleted])
  .emits([AssistantDelta, ModelStep, ToolCallRequested, AssistantMessage, ContextCompacted])
  .dependsOn([Model, Workspace])
  .folds([Conversation, StepProgress])
  .logic(async ({ params, emit, folds, layers, signal, reportUsage }) => {
    /** One model call, its usage reported for the run. */
    const complete = async (
      messages: ChatMessage[],
      tools: ModelTool[],
      onText: (delta: string) => void = () => {},
    ) => {
      const response = await layers.Model.complete({ messages, tools, signal, onText });
      if (response.usage) reportUsage({ ...response.usage, model: layers.Model.model });
      return response;
    };

    const { steps } = await folds.stepProgress();
    if (steps >= params.maxSteps) {
      emit(
        AssistantMessage.make({
          text: `Stopped: reached the limit of ${params.maxSteps} tool steps for one turn.`,
        }),
      );
      return;
    }

    // Reads the conversation (the trigger and every tool result stored before it included) and
    // compacts it first when the view does not fit and something is older than what it keeps.
    // Events published meanwhile are kept: the runtime folds them on top of the summary.
    const {
      state: conversation,
      compacted,
      summarized,
    } = await folds.conversation.compact({
      view: ChatView,
      budget: params.contextBudget,
      keepTokens: params.keepTokens,
      keepFrom: ContextStrategy.newest(), // the step the model is working on
      summarize: async ({ summary, older }) => {
        // A tool-less request per budget of transcript, each carrying the summary so far. The view
        // fits on elided tool outputs, but `older` holds them in full, so a tool-heavy compaction
        // often sends more than a budget; after a version bump of Conversation, all of the history.
        const summarizeChunk = async (earlier: string | undefined, chunk: typeof older) =>
          (await complete(compactionMessages(earlier, chunk), [])).text.trim();
        const [first, ...rest] = compactionChunks(older, params.contextBudget);
        let next = await summarizeChunk(summary, first);
        for (const chunk of rest) next = await summarizeChunk(next, chunk);
        return next;
      },
    });
    if (compacted) emit(ContextCompacted.make({ summarized }));
    const chat = ChatView(conversation, { budget: params.contextBudget });

    const response = await complete(
      [
        { role: 'system', content: systemPrompt(layers.Workspace.root, params.instructions) },
        ...toChatMessages(chat.state),
      ],
      toOpenAITools(codingTools),
      (text) => emit(AssistantDelta.make({ text })),
    );

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
