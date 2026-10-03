import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createProvider,
  maskSecret,
  testProviderConnection,
  validateProviderConfig,
} from './index';
import { openAIJsonModeInput } from './openai';
import type { GenerateResult, ProviderConfig } from './types';
import { ProviderError } from './types';

type Call = { url: string; init: RequestInit & { headers: Headers } };

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers(init?.headers);
}

/** Mock fetch that records calls (normalizing `Request` objects) and returns queued responses. */
function mockFetch(...responses: (Response | (() => Response) | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = input instanceof Request ? await input.clone().text() : init?.body;
    calls.push({ url, init: { ...init, body: body as BodyInit, headers: headersOf(input, init) } });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sse(events: { type: string; [k: string]: unknown }[]): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function claudeStream(text: string, stopReason = 'end_turn', model = 'claude-opus-5') {
  return () =>
    sse([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: 'message_stop' },
    ]);
}

const bodyOf = (call: Call) => JSON.parse(String(call.init.body));

const anthropicConfig: ProviderConfig = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  authMode: 'apiKey',
  credentials: { apiKey: 'sk-ant-test' },
};

describe('anthropic provider', () => {
  it('streams a Messages request with browser access, fallbacks for Opus 5, and returns text', async () => {
    const { fetch, calls } = mockFetch(claudeStream('{"ok":true}'));
    const result = await (await createProvider(anthropicConfig, { fetch })).generate({
      system: 'sys',
      prompt: 'hi',
    });

    expectTypeOf(result).toEqualTypeOf<GenerateResult>();
    expect(result).toEqual({
      text: '{"ok":true}',
      model: 'claude-opus-5',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(calls[0].init.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(calls[0].init.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(calls[0].init.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    expect(bodyOf(calls[0])).toMatchObject({
      model: 'claude-opus-5',
      stream: true,
      system: 'sys',
      fallbacks: 'default',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('sends the cacheable prefix as its own cache-marked block', async () => {
    const { fetch, calls } = mockFetch(claudeStream('{}'));
    await (await createProvider(anthropicConfig, { fetch })).generate({
      system: 's',
      cacheablePrefix: 'samples',
      prompt: 'fix it',
    });
    expect(bodyOf(calls[0]).messages[0].content).toEqual([
      { type: 'text', text: 'samples', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'fix it' },
    ]);
  });

  it('uses the stable endpoint without fallbacks for other models', async () => {
    const { fetch, calls } = mockFetch(claudeStream('x', 'end_turn', 'claude-haiku-4-5'));
    await (
      await createProvider({ ...anthropicConfig, model: 'claude-haiku-4-5' }, { fetch })
    ).generate({
      system: 's',
      prompt: 'p',
    });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(bodyOf(calls[0]).fallbacks).toBeUndefined();
  });

  it('maps refusal, truncation and HTTP errors to ProviderError kinds', async () => {
    const run = async (res: Response | (() => Response)) =>
      (await createProvider(anthropicConfig, { fetch: mockFetch(res).fetch })).generate({
        system: 's',
        prompt: 'p',
      });
    await expect(run(claudeStream('', 'refusal'))).rejects.toMatchObject({ kind: 'refusal' });
    await expect(run(claudeStream('{"a"', 'max_tokens'))).rejects.toMatchObject({
      kind: 'truncated',
    });
    await expect(
      run(
        json(401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});

describe('bedrock mantle provider', () => {
  it('sends a bearer-authenticated Messages request to the regional Mantle endpoint', async () => {
    const { fetch, calls } = mockFetch(claudeStream('{}', 'end_turn', 'anthropic.claude-opus-5'));
    const result = await (
      await createProvider(
        {
          provider: 'bedrock-mantle',
          model: 'anthropic.claude-opus-5',
          region: 'eu-central-1',
          authMode: 'apiKey',
          credentials: { apiKey: 'ABSKkey' },
        },
        { fetch },
      )
    ).generate({ system: 's', prompt: 'p' });
    expect(result.model).toBe('anthropic.claude-opus-5');
    expect(calls[0].url).toBe('https://bedrock-mantle.eu-central-1.api.aws/anthropic/v1/messages');
    expect(calls[0].init.headers.get('authorization')).toBe('Bearer ABSKkey');
    expect(bodyOf(calls[0])).toMatchObject({ model: 'anthropic.claude-opus-5', stream: true });
  });
});

describe('openai provider', () => {
  const config: ProviderConfig = {
    provider: 'openai',
    model: 'gpt-5.4',
    authMode: 'apiKey',
    credentials: { apiKey: 'sk-openai' },
  };

  it('calls the Responses API in JSON mode and joins output_text parts', async () => {
    const { fetch, calls } = mockFetch(
      json(200, {
        model: 'gpt-5.4-2026-03-05',
        status: 'completed',
        output: [
          { type: 'reasoning' },
          {
            type: 'message',
            content: [
              { type: 'output_text', text: '{"a":' },
              { type: 'output_text', text: '1}' },
            ],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    const result = await (await createProvider(config, { fetch })).generate({
      system: 'sys',
      cacheablePrefix: 'ctx',
      prompt: 'p',
      maxTokens: 99,
    });
    expect(result).toEqual({
      text: '{"a":1}',
      model: 'gpt-5.4-2026-03-05',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0].init.headers.get('authorization')).toBe('Bearer sk-openai');
    expect(bodyOf(calls[0])).toEqual({
      model: 'gpt-5.4',
      instructions: 'sys',
      input: 'ctx\n\np\n\nRespond with a single JSON object.',
      max_output_tokens: 99,
      text: { format: { type: 'json_object' } },
    });
  });

  it('maps HTTP errors, incomplete responses, refusals and network failures', async () => {
    const run = async (res: Response | Error) =>
      (await createProvider(config, { fetch: mockFetch(res).fetch })).generate({
        system: 's',
        prompt: 'p',
      });
    await expect(run(json(429, { error: { message: 'slow down' } }))).rejects.toMatchObject({
      kind: 'rate_limit',
      message: 'slow down',
    });
    await expect(
      run(
        json(200, {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'truncated' });
    await expect(
      run(
        json(200, {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
        }),
      ),
    ).rejects.toMatchObject({ kind: 'refusal', message: 'no' });
    await expect(run(new TypeError('Failed to fetch'))).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('bedrock converse provider', () => {
  const base: ProviderConfig = {
    provider: 'bedrock',
    model: 'us.anthropic.claude-opus-5-v1:0',
    region: 'us-west-2',
    authMode: 'apiKey',
    credentials: { apiKey: 'ABSKkey' },
  };
  const ok = () =>
    json(200, {
      output: { message: { role: 'assistant', content: [{ text: '{"m":1}' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: 2 },
    });

  it('posts a Converse request with bearer auth and an encoded model id', async () => {
    const { fetch, calls } = mockFetch(ok());
    const result = await (await createProvider(base, { fetch })).generate({
      system: 'sys',
      prompt: 'p',
      maxTokens: 50,
    });
    expect(result).toEqual({
      text: '{"m":1}',
      model: base.model,
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(calls[0].url).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-opus-5-v1%3A0/converse',
    );
    expect(calls[0].init.headers.get('authorization')).toBe('Bearer ABSKkey');
    expect(bodyOf(calls[0])).toEqual({
      system: [{ text: 'sys' }],
      messages: [{ role: 'user', content: [{ text: 'p' }] }],
      inferenceConfig: { maxTokens: 50 },
    });
  });

  it('signs requests with SigV4 when using access keys', async () => {
    const { fetch, calls } = mockFetch(ok());
    await (
      await createProvider(
        {
          ...base,
          authMode: 'awsKeys',
          credentials: {
            awsAccessKeyId: 'AKIDEXAMPLE',
            awsSecretAccessKey: 'secret',
            awsSessionToken: 'tok',
          },
        },
        { fetch },
      )
    ).generate({ system: 's', prompt: 'p' });
    const auth = calls[0].init.headers.get('authorization') ?? '';
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request/,
    );
    expect(calls[0].init.headers.get('x-amz-security-token')).toBe('tok');
    expect(bodyOf(calls[0]).messages[0].content[0].text).toBe('p');
  });

  it('maps errors and stop reasons', async () => {
    const run = async (res: Response) =>
      (await createProvider(base, { fetch: mockFetch(res).fetch })).generate({
        system: 's',
        prompt: 'p',
      });
    await expect(run(json(403, { message: 'denied' }))).rejects.toMatchObject({
      kind: 'auth',
      message: 'denied',
    });
    await expect(run(json(404, { message: 'no model' }))).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(
      run(json(200, { output: { message: { content: [] } }, stopReason: 'max_tokens' })),
    ).rejects.toMatchObject({ kind: 'truncated' });
    await expect(
      run(json(200, { output: { message: { content: [] } }, stopReason: 'guardrail_intervened' })),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('testProviderConnection', () => {
  it('runs a tiny generation and reports the model', async () => {
    const { fetch, calls } = mockFetch(
      json(200, {
        model: 'gpt-5.4',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      }),
    );
    const result = await testProviderConnection(
      { provider: 'openai', model: 'gpt-5.4', authMode: 'apiKey', credentials: { apiKey: 'k' } },
      { fetch },
    );
    expect(result.model).toBe('gpt-5.4');
    expect(bodyOf(calls[0]).max_output_tokens).toBe(256);
  });
});

describe('validateProviderConfig / maskSecret', () => {
  it('reports missing model, region and credentials', () => {
    expect(validateProviderConfig(anthropicConfig)).toEqual([]);
    expect(
      validateProviderConfig({
        provider: 'bedrock',
        model: '',
        authMode: 'awsKeys',
        credentials: { awsAccessKeyId: 'a' },
      }),
    ).toEqual([
      'Model is required.',
      'Region is required.',
      'AWS access key id and secret access key are required.',
    ]);
    expect(validateProviderConfig({ ...anthropicConfig, authMode: 'awsKeys' })).toContain(
      'Unsupported auth mode.',
    );
    expect(validateProviderConfig({ ...anthropicConfig, credentials: {} })).toEqual([
      'Anthropic API key is required.',
    ]);
  });

  it('masks secrets keeping a prefix and the last 4 chars', () => {
    expect(maskSecret('sk-ant-api03-abcdefghijkl')).toBe('sk-ant-…ijkl');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBe('—');
  });
});

describe('openAIJsonModeInput', () => {
  it('adds a JSON reminder only when the input does not mention json', () => {
    expect(openAIJsonModeInput('samples')).toBe('samples\n\nRespond with a single JSON object.');
    expect(openAIJsonModeInput('Return a JSON object')).toBe('Return a JSON object');
  });
});
