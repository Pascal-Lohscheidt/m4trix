import { addTokens } from './cost.js';
import type { TraceTokens } from './types.js';

/** Usage and model of one LLM call, as far as its output reveals them. */
export type LlmCallDetails = {
  tokens?: TraceTokens;
  model?: string;
};

type Json = Record<string, unknown>;

/**
 * Reads token usage and the served model from an LLM call's output. Understands LangChain
 * `LLMResult`s and messages (`usage_metadata`, `response_metadata`, the legacy `llmOutput` fields),
 * in memory or serialized, plus raw OpenAI and Anthropic responses.
 */
export function readLlmOutput(output: unknown): LlmCallDetails {
  const record = asRecord(output);
  if (!record) return {};

  if (Array.isArray(record.generations) || 'llmOutput' in record) return readLlmResult(record);

  const message = readMessage(record);
  if (message) return message;

  return compact({ tokens: readProviderUsage(record.usage), model: readString(record.model) });
}

/** Model and provider requested at the start of a LangChain chat model or LLM run. */
export function readLangChainModelParams(
  extraParams: unknown,
  metadata: Record<string, unknown> | undefined,
): { model?: string; provider?: string } {
  const invocation = asRecord(asRecord(extraParams)?.invocation_params);
  const model =
    readString(invocation?.model) ??
    readString(invocation?.model_name) ??
    readString(invocation?.modelName) ??
    readString(metadata?.ls_model_name);
  const provider = readString(metadata?.ls_provider);
  return compact({ model, provider });
}

function readLlmResult(result: Json): LlmCallDetails {
  let tokens: TraceTokens | undefined;
  let model: string | undefined;

  const generations = Array.isArray(result.generations) ? result.generations : [];
  for (const prompt of generations) {
    if (!Array.isArray(prompt)) continue;
    // Choices of one prompt share a response; count its usage once.
    for (const generation of prompt) {
      const message = readMessage(asRecord(asRecord(generation)?.message));
      model ??= message?.model;
      if (message?.tokens) {
        tokens = addTokens(tokens, message.tokens);
        break;
      }
    }
  }

  const llmOutput = asRecord(result.llmOutput);
  return compact({
    tokens: tokens ?? readLegacyUsage(llmOutput),
    model: model ?? readString(llmOutput?.model_name) ?? readString(llmOutput?.model),
  });
}

/** A LangChain message, either an instance or its `{ lc, kwargs }` serialization. */
function readMessage(message: Json | undefined): LlmCallDetails | undefined {
  if (!message) return undefined;
  const fields = asRecord(message.kwargs) ?? message;
  const usage = asRecord(fields.usage_metadata);
  const responseMetadata = asRecord(fields.response_metadata);
  if (!usage && !responseMetadata) return undefined;

  return compact({
    tokens: usage ? readUsageMetadata(usage) : readLegacyUsage(responseMetadata),
    model:
      readString(responseMetadata?.model_name) ??
      readString(responseMetadata?.model) ??
      readString(responseMetadata?.modelId),
  });
}

/** LangChain's `usage_metadata`: input totals already include cache reads and writes. */
function readUsageMetadata(usage: Json): TraceTokens | undefined {
  const input = readNumber(usage.input_tokens);
  const output = readNumber(usage.output_tokens);
  if (input === undefined && output === undefined) return undefined;

  const inputDetails = asRecord(usage.input_token_details);
  const outputDetails = asRecord(usage.output_token_details);
  return compact({
    input: input ?? 0,
    output: output ?? 0,
    cached: readNumber(inputDetails?.cache_read),
    cacheCreation: readNumber(inputDetails?.cache_creation),
    reasoning: readNumber(outputDetails?.reasoning),
  }) as TraceTokens;
}

function readLegacyUsage(llmOutput: Json | undefined): TraceTokens | undefined {
  if (!llmOutput) return undefined;
  const tokenUsage = asRecord(llmOutput.tokenUsage) ?? asRecord(llmOutput.estimatedTokenUsage);
  if (tokenUsage) {
    const input =
      readNumber(tokenUsage.promptTokens) ??
      readNumber(tokenUsage.input_tokens) ??
      readNumber(tokenUsage.inputTokens);
    const output =
      readNumber(tokenUsage.completionTokens) ??
      readNumber(tokenUsage.output_tokens) ??
      readNumber(tokenUsage.outputTokens);
    if (input !== undefined || output !== undefined) {
      return compact({
        input: input ?? 0,
        output: output ?? 0,
        cached: readNumber(tokenUsage.cachedTokens) ?? readNumber(tokenUsage.cached_tokens),
      }) as TraceTokens;
    }
  }
  return readProviderUsage(llmOutput.usage);
}

/**
 * A provider's raw `usage` object. Anthropic reports cache reads and writes next to, not inside,
 * `input_tokens`; OpenAI's prompt totals already include cached tokens.
 */
function readProviderUsage(value: unknown): TraceTokens | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const cacheRead = readNumber(usage.cache_read_input_tokens);
  const cacheWrite = readNumber(usage.cache_creation_input_tokens);
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    const output = readNumber(usage.output_tokens) ?? 0;
    return compact({
      input: (readNumber(usage.input_tokens) ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
      output,
      cached: cacheRead,
      cacheCreation: cacheWrite,
    }) as TraceTokens;
  }

  const input = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens);
  const output = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const inputDetails =
    asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details);
  const outputDetails =
    asRecord(usage.completion_tokens_details) ?? asRecord(usage.output_tokens_details);
  return compact({
    input: input ?? 0,
    output: output ?? 0,
    cached: readNumber(inputDetails?.cached_tokens),
    reasoning: readNumber(outputDetails?.reasoning_tokens),
  }) as TraceTokens;
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
