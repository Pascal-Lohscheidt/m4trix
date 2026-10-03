import { AwsClient } from 'aws4fetch';
import {
  joinPrompt,
  kindForStatus,
  type MapperProvider,
  type ProviderConfig,
  type ProviderDeps,
  ProviderError,
  toNetworkOrAbortError,
} from './types';

const DEFAULT_MAX_TOKENS = 32_000;

export function bedrockConverseUrl(region: string, modelId: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
}

type ConverseBody = {
  output?: { message?: { content?: { text?: string }[] } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; Message?: string };
    return body.message ?? body.Message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Amazon Bedrock Converse API — model-agnostic, Bedrock API key (Bearer) or SigV4 access keys. */
export function createBedrockProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
): MapperProvider {
  const region = config.region ?? '';
  const baseFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const c = config.credentials;
  const signer =
    config.authMode === 'awsKeys'
      ? new AwsClient({
          accessKeyId: c.awsAccessKeyId ?? '',
          secretAccessKey: c.awsSecretAccessKey ?? '',
          sessionToken: c.awsSessionToken || undefined,
          service: 'bedrock',
          region,
        })
      : null;

  return {
    id: 'bedrock',
    async generate(request) {
      const url = bedrockConverseUrl(region, config.model);
      const init: RequestInit = {
        method: 'POST',
        signal: request.signal,
        headers: {
          'content-type': 'application/json',
          ...(signer ? {} : { authorization: `Bearer ${c.apiKey ?? ''}` }),
        },
        body: JSON.stringify({
          system: [{ text: request.system }],
          messages: [{ role: 'user', content: [{ text: joinPrompt(request) }] }],
          inferenceConfig: { maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS },
        }),
      };

      let res: Response;
      try {
        res = signer ? await baseFetch(await signer.sign(url, init)) : await baseFetch(url, init);
      } catch (err) {
        throw toNetworkOrAbortError(err);
      }
      if (!res.ok) {
        throw new ProviderError(kindForStatus(res.status), await readErrorMessage(res), res.status);
      }
      const body = (await res.json()) as ConverseBody;
      if (body.stopReason === 'max_tokens') {
        throw new ProviderError(
          'truncated',
          'The response hit the output token limit before finishing.',
        );
      }
      if (body.stopReason === 'guardrail_intervened' || body.stopReason === 'content_filtered') {
        throw new ProviderError('refusal', `Generation stopped: ${body.stopReason}.`);
      }
      return {
        text: (body.output?.message?.content ?? [])
          .map((part) => part.text ?? '')
          .join('')
          .trim(),
        model: config.model,
        usage: { inputTokens: body.usage?.inputTokens, outputTokens: body.usage?.outputTokens },
      };
    },
  };
}
