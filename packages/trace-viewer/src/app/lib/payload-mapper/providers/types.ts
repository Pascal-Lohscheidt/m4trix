export type MapperProviderId = 'anthropic' | 'openai' | 'bedrock' | 'bedrock-mantle';

export type ProviderAuthMode = 'apiKey' | 'awsKeys';

export type ProviderCredentials = {
  apiKey?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
};

export type ProviderConfig = {
  provider: MapperProviderId;
  model: string;
  /** AWS region for Bedrock providers. */
  region?: string;
  authMode: ProviderAuthMode;
  credentials: ProviderCredentials;
};

export type GenerateRequest = {
  system: string;
  /**
   * Stable leading context (e.g. samples) reused across repair rounds. Claude providers send it
   * as a separate cache-marked block; other providers prepend it to `prompt`.
   */
  cacheablePrefix?: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type GenerateResult = {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'not_found'
  | 'network'
  | 'refusal'
  | 'truncated'
  | 'aborted'
  | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export type MapperProvider = {
  id: MapperProviderId;
  generate(request: GenerateRequest): Promise<GenerateResult>;
};

export type ProviderDeps = {
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'other';
}

/** Network failures from `fetch` (including CORS rejections) surface as `TypeError`. */
export function toNetworkOrAbortError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ProviderError('aborted', 'Request was cancelled.');
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(
    'network',
    `Network error: ${message}. Check the region/endpoint and that the browser can reach it.`,
  );
}

/** `cacheablePrefix` + `prompt` as one string, for providers without explicit cache blocks. */
export function joinPrompt(request: Pick<GenerateRequest, 'cacheablePrefix' | 'prompt'>): string {
  return [request.cacheablePrefix, request.prompt].filter((p) => p?.trim()).join('\n\n');
}
