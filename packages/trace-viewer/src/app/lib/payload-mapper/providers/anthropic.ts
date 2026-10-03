import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk/mantle-client';
import Anthropic from '@anthropic-ai/sdk';
import {
  type GenerateRequest,
  type GenerateResult,
  kindForStatus,
  type MapperProvider,
  type ProviderConfig,
  type ProviderDeps,
  ProviderError,
  toNetworkOrAbortError,
} from './types';

const DEFAULT_MAX_TOKENS = 32_000;

/** Models that run safety classifiers and should opt into server-side refusal fallbacks. */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|mythos-5)/;

/** Structural subset shared by stable and beta (fallback) message responses. */
type ClaudeMessage = {
  content: ReadonlyArray<{ type: string; text?: unknown }>;
  stop_reason: string | null;
  model: string;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
};

export function toClaudeResult(message: ClaudeMessage): GenerateResult {
  if (message.stop_reason === 'refusal') {
    throw new ProviderError(
      'refusal',
      'The model declined to generate a mapping for these samples.',
    );
  }
  const text = message.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
  if (message.stop_reason === 'max_tokens') {
    throw new ProviderError(
      'truncated',
      'The response hit the output token limit before finishing.',
    );
  }
  return {
    text,
    model: message.model,
    usage: {
      inputTokens: message.usage?.input_tokens ?? undefined,
      outputTokens: message.usage?.output_tokens ?? undefined,
    },
  };
}

export function toClaudeProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ProviderError('aborted', 'Request was cancelled.');
  }
  if (err instanceof Anthropic.APIConnectionError) return toNetworkOrAbortError(err);
  // Mantle errors come from the Bedrock SDK's own error classes; match on the status shape.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    const message = err instanceof Error ? err.message : `HTTP ${status}`;
    return new ProviderError(kindForStatus(status), message, status);
  }
  return toNetworkOrAbortError(err);
}

/** The stable prefix gets its own cache breakpoint so repair rounds read it from cache. */
export function claudeUserContent(request: GenerateRequest): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [];
  if (request.cacheablePrefix?.trim()) {
    blocks.push({
      type: 'text',
      text: request.cacheablePrefix,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (request.prompt.trim()) blocks.push({ type: 'text', text: request.prompt });
  return blocks;
}

function baseParams(model: string, request: GenerateRequest) {
  return {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: [{ role: 'user' as const, content: claudeUserContent(request) }],
  };
}

export function createAnthropicProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
): MapperProvider {
  const client = new Anthropic({
    apiKey: config.credentials.apiKey,
    dangerouslyAllowBrowser: true,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return {
    id: 'anthropic',
    async generate(request) {
      try {
        const params = baseParams(config.model, request);
        const options = { signal: request.signal };
        // Streaming avoids HTTP timeouts on long mapping outputs.
        const message = FALLBACK_MODELS.test(config.model)
          ? await client.beta.messages
              .stream(
                { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
                options,
              )
              .finalMessage()
          : await client.messages.stream(params, options).finalMessage();
        return toClaudeResult(message);
      } catch (err) {
        throw toClaudeProviderError(err);
      }
    },
  };
}

export function createBedrockMantleProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
): MapperProvider {
  const c = config.credentials;
  const client = new AnthropicBedrockMantle({
    awsRegion: config.region,
    dangerouslyAllowBrowser: true,
    ...(config.authMode === 'apiKey'
      ? { apiKey: c.apiKey }
      : {
          awsAccessKey: c.awsAccessKeyId,
          awsSecretAccessKey: c.awsSecretAccessKey,
          awsSessionToken: c.awsSessionToken || null,
        }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return {
    id: 'bedrock-mantle',
    async generate(request) {
      try {
        const message = await client.messages
          .stream(baseParams(config.model, request), { signal: request.signal })
          .finalMessage();
        return toClaudeResult(message);
      } catch (err) {
        throw toClaudeProviderError(err);
      }
    },
  };
}
