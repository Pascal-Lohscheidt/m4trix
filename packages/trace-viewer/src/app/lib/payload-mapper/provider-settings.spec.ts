import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_SETTINGS,
  normalizeProviderSettings,
  normalizeStoredKeys,
  resolveProviderConfig,
} from './provider-settings';

describe('normalizeProviderSettings', () => {
  it('defaults everything for missing or junk input', () => {
    expect(normalizeProviderSettings(null)).toEqual(DEFAULT_PROVIDER_SETTINGS);
    expect(normalizeProviderSettings({ provider: 'gemini', rememberKeys: 'yes' })).toEqual(
      DEFAULT_PROVIDER_SETTINGS,
    );
  });

  it('keeps known providers and drops unsupported auth modes', () => {
    const s = normalizeProviderSettings({
      provider: 'bedrock',
      models: { bedrock: 'm', nope: 'x' },
      regions: { bedrock: 'eu-west-1' },
      authModes: { bedrock: 'awsKeys', anthropic: 'awsKeys' },
      rememberKeys: true,
    });
    expect(s).toEqual({
      provider: 'bedrock',
      models: { bedrock: 'm' },
      regions: { bedrock: 'eu-west-1' },
      authModes: { bedrock: 'awsKeys' },
      rememberKeys: true,
      keepSamples: true,
    });
    expect(normalizeProviderSettings({ keepSamples: false }).keepSamples).toBe(false);
  });
});

describe('normalizeStoredKeys', () => {
  it('keeps only known credential fields for known providers', () => {
    expect(
      normalizeStoredKeys({
        openai: { apiKey: 'k', extra: 'x' },
        bedrock: { awsAccessKeyId: 'a', awsSecretAccessKey: 's', awsSessionToken: '' },
        foo: { apiKey: 'k' },
        anthropic: {},
      }),
    ).toEqual({
      openai: { apiKey: 'k' },
      bedrock: { awsAccessKeyId: 'a', awsSecretAccessKey: 's' },
    });
  });
});

describe('resolveProviderConfig', () => {
  it('fills catalog defaults for model, region and auth mode', () => {
    expect(
      resolveProviderConfig({ ...DEFAULT_PROVIDER_SETTINGS, provider: 'bedrock-mantle' }, {}),
    ).toEqual({
      provider: 'bedrock-mantle',
      model: 'anthropic.claude-opus-5',
      region: 'us-east-1',
      authMode: 'apiKey',
      credentials: {},
    });
  });

  it('uses per-provider overrides and credentials; no region for non-AWS providers', () => {
    const config = resolveProviderConfig(
      {
        ...DEFAULT_PROVIDER_SETTINGS,
        provider: 'openai',
        models: { openai: ' gpt-x ' },
        regions: { openai: 'x' },
      },
      { openai: { apiKey: 'sk' } },
    );
    expect(config).toEqual({
      provider: 'openai',
      model: 'gpt-x',
      region: undefined,
      authMode: 'apiKey',
      credentials: { apiKey: 'sk' },
    });
  });
});
