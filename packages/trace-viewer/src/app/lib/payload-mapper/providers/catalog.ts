import type { MapperProviderId, ProviderAuthMode, ProviderConfig } from './types';

export type ProviderInfo = {
  id: MapperProviderId;
  label: string;
  /** Suggested model id; empty when the account-specific id must be entered. */
  defaultModel: string;
  modelPlaceholder: string;
  needsRegion: boolean;
  defaultRegion?: string;
  authModes: ProviderAuthMode[];
  keyLabel: string;
  keyPlaceholder: string;
  /** Host shown in the route diagram. */
  endpoint: (region: string) => string;
  docsHint: string;
};

export const PROVIDERS: Record<MapperProviderId, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude API',
    defaultModel: 'claude-opus-5',
    modelPlaceholder: 'claude-opus-5',
    needsRegion: false,
    authModes: ['apiKey'],
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    endpoint: () => 'api.anthropic.com',
    docsHint: 'Create a key at platform.claude.com → API keys.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.4',
    modelPlaceholder: 'gpt-5.4',
    needsRegion: false,
    authModes: ['apiKey'],
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    endpoint: () => 'api.openai.com',
    docsHint: 'Uses the Responses API in JSON mode.',
  },
  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    defaultModel: '',
    modelPlaceholder: 'Model or inference profile id from the Bedrock console',
    needsRegion: true,
    defaultRegion: 'us-east-1',
    authModes: ['apiKey', 'awsKeys'],
    keyLabel: 'Bedrock API key',
    keyPlaceholder: 'ABSK…',
    endpoint: (region) => `bedrock-runtime.${region}.amazonaws.com`,
    docsHint: 'Converse API — works with any Bedrock text model enabled in your account.',
  },
  'bedrock-mantle': {
    id: 'bedrock-mantle',
    label: 'Amazon Bedrock Mantle',
    defaultModel: 'anthropic.claude-opus-5',
    modelPlaceholder: 'anthropic.claude-opus-5',
    needsRegion: true,
    defaultRegion: 'us-east-1',
    authModes: ['apiKey', 'awsKeys'],
    keyLabel: 'Bedrock API key',
    keyPlaceholder: 'ABSK…',
    endpoint: (region) => `bedrock-mantle.${region}.api.aws`,
    docsHint: 'Claude Messages API on Bedrock; model ids use the "anthropic." prefix.',
  },
};

export const PROVIDER_ORDER: MapperProviderId[] = [
  'anthropic',
  'openai',
  'bedrock',
  'bedrock-mantle',
];

/** Returns a list of human-readable problems; empty when the config can be used. */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const info = PROVIDERS[config.provider];
  const problems: string[] = [];
  if (!config.model.trim()) problems.push('Model is required.');
  if (info.needsRegion && !config.region?.trim()) problems.push('Region is required.');
  if (!info.authModes.includes(config.authMode)) problems.push('Unsupported auth mode.');
  const c = config.credentials;
  if (config.authMode === 'apiKey' && !c.apiKey?.trim())
    problems.push(`${info.keyLabel} is required.`);
  if (
    config.authMode === 'awsKeys' &&
    (!c.awsAccessKeyId?.trim() || !c.awsSecretAccessKey?.trim())
  ) {
    problems.push('AWS access key id and secret access key are required.');
  }
  return problems;
}

/** Mask a secret for display: keeps a short prefix and the last 4 characters. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '—';
  const s = secret.trim();
  if (s.length <= 8) return '••••';
  const prefix = s.match(/^[A-Za-z]+[-_]?(?:[a-z]+-)?/)?.[0]?.slice(0, 7) ?? '';
  return `${prefix}…${s.slice(-4)}`;
}
