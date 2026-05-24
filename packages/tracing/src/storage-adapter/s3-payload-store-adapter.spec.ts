import { describe, expect, it, vi } from 'vitest';
import { S3PayloadStoreAdapter } from './s3-payload-store-adapter.js';

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

function createMockS3Client(objects: Map<string, Uint8Array>): import('@aws-sdk/client-s3').S3Client {
  return {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      const input = command.input;

      if (name === 'PutObjectCommand') {
        const key = input.Key as string;
        const body = input.Body;
        objects.set(
          key,
          body instanceof Buffer ? body : new TextEncoder().encode(String(body)),
        );
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
    }),
  } as unknown as import('@aws-sdk/client-s3').S3Client;
}
