import type { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveS3PayloadStoreOptionsFromEnv,
  S3PayloadStoreAdapter,
  type S3PayloadStoreAdapterOptions,
} from './s3-payload-store-adapter.js';

describe('S3PayloadStoreAdapter request addressing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses path-style URLs for a custom endpoint such as LocalStack or MinIO', async () => {
    const request = await captureRequest({ endpoint: 'http://localhost:4566' });

    expect(request).toMatchObject({ hostname: 'localhost', path: '/trace-payloads/a/b.json' });
  });

  it('treats the S3-specific endpoint variable as a custom endpoint too', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://minio.internal:9000');

    const request = await captureRequest({});

    expect(request).toMatchObject({ hostname: 'minio.internal', path: '/trace-payloads/a/b.json' });
  });

  it('uses virtual-hosted URLs against AWS itself', async () => {
    const request = await captureRequest({});

    expect(request.hostname).toBe('trace-payloads.s3.us-east-1.amazonaws.com');
    expect(request.path).toBe('/a/b.json');
  });

  it('lets an explicit forcePathStyle override the endpoint default', async () => {
    const request = await captureRequest({
      endpoint: 'http://localhost:4566',
      forcePathStyle: false,
    });

    expect(request.hostname).toBe('trace-payloads.localhost');
  });

  it('reads the path-style override from the environment', () => {
    vi.stubEnv('TRACE_S3_BUCKET', 'trace-payloads');
    vi.stubEnv('TRACE_S3_FORCE_PATH_STYLE', 'false');
    expect(resolveS3PayloadStoreOptionsFromEnv()).toMatchObject({ forcePathStyle: false });

    vi.stubEnv('TRACE_S3_FORCE_PATH_STYLE', 'true');
    expect(resolveS3PayloadStoreOptionsFromEnv()).toMatchObject({ forcePathStyle: true });

    vi.stubEnv('TRACE_S3_FORCE_PATH_STYLE', 'yes please');
    expect(() => resolveS3PayloadStoreOptionsFromEnv()).toThrow('TRACE_S3_FORCE_PATH_STYLE');
  });
});

/** Sends one put through a real S3 client and returns the HTTP request it would have made. */
async function captureRequest(
  options: Partial<S3PayloadStoreAdapterOptions>,
): Promise<{ hostname: string; path: string }> {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
  vi.stubEnv('AWS_ENDPOINT_URL', '');
  if (!process.env.AWS_ENDPOINT_URL_S3) vi.stubEnv('AWS_ENDPOINT_URL_S3', '');
  const adapter = new S3PayloadStoreAdapter({
    bucket: 'trace-payloads',
    region: 'us-east-1',
    ...options,
  });
  const requests: { hostname: string; path: string }[] = [];
  const client = (adapter as unknown as { client: S3Client }).client;
  client.config.requestHandler = {
    handle: async (request: { hostname: string; path: string }) => {
      requests.push(request);
      throw new Error('request captured');
    },
  } as unknown as S3Client['config']['requestHandler'];

  await expect(adapter.putJson('a/b.json', {})).rejects.toThrow('request captured');
  return requests[0];
}

describe('S3PayloadStoreAdapter', () => {
  it('writes and reads JSON payloads under a logical ref', async () => {
    const objects = new Map<string, Uint8Array>();
    const client = createMockS3Client(objects);
    const adapter = new S3PayloadStoreAdapter({
      bucket: 'trace-payloads',
      prefix: 'prod/',
      client,
    });

    const ref = await adapter.putJson('traces/t1/payloads/r1/input.json', { prompt: 'hi' });
    expect(ref).toBe('traces/t1/payloads/r1/input.json');
    expect(objects.has('prod/traces/t1/payloads/r1/input.json')).toBe(true);

    await expect(adapter.getJson(ref)).resolves.toEqual({ prompt: 'hi' });
  });

  it('rejects path traversal', async () => {
    const adapter = new S3PayloadStoreAdapter({
      bucket: 'trace-payloads',
      client: createMockS3Client(new Map()),
    });

    await expect(adapter.putJson('../secret.json', {})).rejects.toThrow(/Expected relative path/);
  });

  it('writes and reads stream payloads', async () => {
    const objects = new Map<string, Uint8Array>();
    const adapter = new S3PayloadStoreAdapter({
      bucket: 'trace-payloads',
      client: createMockS3Client(objects),
    });

    const ref = await adapter.putStream('traces/t1/payloads/r1/events.ndjson', [
      new TextEncoder().encode('line1\n'),
    ]);
    const stream = await adapter.getStream(ref);
    const reader = stream.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe('line1\n');
  });
});

function createMockS3Client(
  objects: Map<string, Uint8Array>,
): import('@aws-sdk/client-s3').S3Client {
  return {
    send: vi.fn(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        const input = command.input;

        if (name === 'PutObjectCommand') {
          const key = input.Key as string;
          const body = input.Body;
          objects.set(key, body instanceof Buffer ? body : new TextEncoder().encode(String(body)));
          return {};
        }

        if (name === 'GetObjectCommand') {
          const key = input.Key as string;
          const bytes = objects.get(key);
          return {
            Body: {
              transformToString: async () => new TextDecoder().decode(bytes),
              transformToByteArray: async () => bytes ?? new Uint8Array(),
            },
          };
        }

        throw new Error(`Unexpected command: ${name}`);
      },
    ),
  } as unknown as import('@aws-sdk/client-s3').S3Client;
}
