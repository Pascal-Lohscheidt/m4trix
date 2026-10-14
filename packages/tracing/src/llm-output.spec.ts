import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { readLangChainModelParams, readLlmOutput } from './llm-output.js';

function aiMessage(usage: {
  input: number;
  output: number;
  cacheRead?: number;
  reasoning?: number;
}) {
  return new AIMessage({
    content: 'hi',
    usage_metadata: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
      ...(usage.cacheRead !== undefined
        ? { input_token_details: { cache_read: usage.cacheRead } }
        : {}),
      ...(usage.reasoning !== undefined
        ? { output_token_details: { reasoning: usage.reasoning } }
        : {}),
    },
    response_metadata: { model_name: 'gpt-4o-2024-08-06' },
  });
}

describe('readLlmOutput', () => {
  it('reads usage and the served model from an LLMResult of chat messages', () => {
    const output = {
      generations: [
        [
          {
            text: 'hi',
            message: aiMessage({ input: 120, output: 30, cacheRead: 100, reasoning: 10 }),
          },
        ],
      ],
      llmOutput: { tokenUsage: { promptTokens: 999, completionTokens: 999 } },
    };

    expect(readLlmOutput(output)).toEqual({
      tokens: { input: 120, output: 30, cached: 100, reasoning: 10 },
      model: 'gpt-4o-2024-08-06',
    });
  });

  it('reads messages in their serialized { lc, kwargs } form', () => {
    const serialized = JSON.parse(JSON.stringify(aiMessage({ input: 5, output: 7 })));

    expect(serialized).toHaveProperty('kwargs');
    expect(readLlmOutput({ generations: [[{ text: 'hi', message: serialized }]] })).toEqual({
      tokens: { input: 5, output: 7 },
      model: 'gpt-4o-2024-08-06',
    });
  });

  it('adds up usage across prompts but counts the choices of one prompt once', () => {
    const output = {
      generations: [
        [
          { text: 'a', message: aiMessage({ input: 10, output: 2 }) },
          { text: 'b', message: aiMessage({ input: 10, output: 2 }) },
        ],
        [{ text: 'c', message: aiMessage({ input: 20, output: 3 }) }],
      ],
    };

    expect(readLlmOutput(output).tokens).toEqual({ input: 30, output: 5 });
  });

  it('reads a bare message, as m4trix LLM spans end with one', () => {
    expect(readLlmOutput(aiMessage({ input: 1, output: 2 }))).toEqual({
      tokens: { input: 1, output: 2 },
      model: 'gpt-4o-2024-08-06',
    });
  });

  it('falls back to legacy llmOutput token usage', () => {
    expect(
      readLlmOutput({
        generations: [[{ text: 'hi' }]],
        llmOutput: {
          tokenUsage: { promptTokens: 3, completionTokens: 4 },
          model_name: 'gpt-3.5-turbo',
        },
      }),
    ).toEqual({ tokens: { input: 3, output: 4 }, model: 'gpt-3.5-turbo' });
    expect(readLlmOutput({ llmOutput: { tokenUsage: { promptTokens: 3 } } })).toEqual({
      tokens: { input: 3, output: 0 },
    });
  });

  it('counts Anthropic cache tokens, which raw usage reports next to input_tokens', () => {
    const anthropic = {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    };

    expect(readLlmOutput(anthropic)).toEqual({
      tokens: { input: 1250, output: 20, cached: 1000, cacheCreation: 200 },
      model: 'claude-sonnet-4-5',
    });
    expect(readLlmOutput({ llmOutput: { usage: anthropic.usage } }).tokens).toMatchObject({
      input: 1250,
      cached: 1000,
    });
  });

  it('reads raw OpenAI chat and responses usage, whose totals include cached tokens', () => {
    expect(
      readLlmOutput({
        model: 'gpt-4o',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      }),
    ).toEqual({ tokens: { input: 100, output: 40, cached: 64, reasoning: 12 }, model: 'gpt-4o' });
    expect(
      readLlmOutput({
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 64 },
        },
      }),
    ).toEqual({ tokens: { input: 100, output: 40, cached: 64 } });
  });

  it('reads usage a message only carries in response_metadata', () => {
    const message = new AIMessage({
      content: 'hi',
      response_metadata: {
        model: 'claude-3-5-haiku',
        usage: { input_tokens: 9, output_tokens: 1 },
      },
    });

    expect(readLlmOutput(message)).toEqual({
      tokens: { input: 9, output: 1 },
      model: 'claude-3-5-haiku',
    });
  });

  it.each([
    undefined,
    null,
    'text',
    42,
    [],
    {},
    { generations: 'nope' },
  ])('finds nothing in %j', (output) => {
    expect(readLlmOutput(output)).toEqual({});
  });
});

describe('readLangChainModelParams', () => {
  it('reads the requested model from invocation params and the provider from ls_ metadata', () => {
    expect(
      readLangChainModelParams(
        { invocation_params: { model: 'gpt-4o', temperature: 0 } },
        { ls_provider: 'openai', ls_model_name: 'ignored' },
      ),
    ).toEqual({ model: 'gpt-4o', provider: 'openai' });
  });

  it('falls back to model_name and ls_model_name', () => {
    expect(
      readLangChainModelParams({ invocation_params: { model_name: 'claude' } }, undefined),
    ).toEqual({
      model: 'claude',
    });
    expect(readLangChainModelParams(undefined, { ls_model_name: 'mistral-large' })).toEqual({
      model: 'mistral-large',
    });
    expect(readLangChainModelParams(undefined, undefined)).toEqual({});
  });
});
