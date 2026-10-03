import type { MapperProvider, ProviderConfig, ProviderDeps } from './types';

export * from './catalog';
export * from './types';

/** Adapters (and their SDKs) are loaded on demand to keep the viewer bundle small. */
export async function createProvider(
  config: ProviderConfig,
  deps: ProviderDeps = {},
): Promise<MapperProvider> {
  switch (config.provider) {
    case 'anthropic':
      return (await import('./anthropic')).createAnthropicProvider(config, deps);
    case 'openai':
      return (await import('./openai')).createOpenAIProvider(config, deps);
    case 'bedrock':
      return (await import('./bedrock')).createBedrockProvider(config, deps);
    case 'bedrock-mantle':
      return (await import('./anthropic')).createBedrockMantleProvider(config, deps);
  }
}

/** Cheap round-trip used by "Test connection". */
export async function testProviderConnection(
  config: ProviderConfig,
  deps: ProviderDeps = {},
  signal?: AbortSignal,
): Promise<{ model: string; latencyMs: number }> {
  const started = Date.now();
  const provider = await createProvider(config, deps);
  const result = await provider.generate({
    system: 'You are a connectivity check. Reply with a JSON object only.',
    prompt: 'Return exactly this JSON object: {"ok": true}',
    maxTokens: 256,
    signal,
  });
  return { model: result.model, latencyMs: Date.now() - started };
}
