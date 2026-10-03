import {
  joinPrompt,
  kindForStatus,
  type MapperProvider,
  type ProviderConfig,
  type ProviderDeps,
  ProviderError,
  toNetworkOrAbortError,
} from './types';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const DEFAULT_MAX_TOKENS = 32_000;

type ResponsesOutputItem = {
  type?: string;
  content?: { type?: string; text?: string; refusal?: string }[];
};

type ResponsesBody = {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | null;
};

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * JSON mode requires the word "json" in the input messages (`instructions` does not count),
 * so append a short reminder when the prompt itself doesn't mention it.
 */
export function openAIJsonModeInput(input: string): string {
  return /json/i.test(input) ? input : `${input}\n\nRespond with a single JSON object.`;
}

export function createOpenAIProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
): MapperProvider {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    id: 'openai',
    async generate(request) {
      let res: Response;
      try {
        res = await doFetch(OPENAI_RESPONSES_URL, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.credentials.apiKey ?? ''}`,
          },
          body: JSON.stringify({
            model: config.model,
            instructions: request.system,
            input: openAIJsonModeInput(joinPrompt(request)),
            max_output_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            // JSON mode guarantees parseable output; schema validation happens client-side.
            text: { format: { type: 'json_object' } },
          }),
        });
      } catch (err) {
        throw toNetworkOrAbortError(err);
      }
      if (!res.ok) {
        throw new ProviderError(kindForStatus(res.status), await readErrorMessage(res), res.status);
      }
      const body = (await res.json()) as ResponsesBody;
      const parts = (body.output ?? [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? []);
      if (parts.some((p) => p.type === 'refusal')) {
        throw new ProviderError(
          'refusal',
          parts.find((p) => p.type === 'refusal')?.refusal ?? 'Refused.',
        );
      }
      if (body.status === 'incomplete') {
        const reason = body.incomplete_details?.reason ?? 'unknown';
        throw new ProviderError(
          reason === 'max_output_tokens' ? 'truncated' : 'other',
          `Response incomplete (${reason}).`,
        );
      }
      return {
        text: parts
          .filter((p) => p.type === 'output_text')
          .map((p) => p.text ?? '')
          .join('')
          .trim(),
        model: body.model ?? config.model,
        usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
      };
    },
  };
}
