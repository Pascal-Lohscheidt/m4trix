import { isAbsolute, normalize, sep } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { PayloadStoreAdapter } from '../types.js';

export type S3PayloadStoreAdapterOptions = {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  client?: S3Client;
};

export class S3PayloadStoreAdapter implements PayloadStoreAdapter {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;

  constructor(options: S3PayloadStoreAdapterOptions) {
    this.bucket = options.bucket;
    this.prefix = normalizePrefix(options.prefix ?? process.env.TRACE_S3_PREFIX ?? '');
    this.client =
      options.client ??
      new S3Client({
        region: options.region ?? process.env.AWS_REGION,
        endpoint: options.endpoint ?? process.env.AWS_ENDPOINT_URL,
      } satisfies S3ClientConfig);
  }

  async putJson(path: string, value: unknown): Promise<string> {
    const { ref, key } = this.resolvePath(path, 'relative path');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: `${JSON.stringify(value, null, 2)}\n`,
        ContentType: 'application/json',
      }),
    );
    return ref;
  }

  async getJson<T = unknown>(ref: string): Promise<T> {
    const { key } = this.resolvePath(ref, 'relative ref');
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    const body = await response.Body?.transformToString('utf-8');
    if (!body) throw new Error(`Empty payload for ref "${ref}"`);
    return JSON.parse(body) as T;
  }

  async putStream(
    path: string,
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }

    const { ref, key } = this.resolvePath(path, 'relative path');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.concat(chunks),
        ContentType: 'application/octet-stream',
      }),
    );
    return ref;
  }

  async getStream(ref: string): Promise<ReadableStream<Uint8Array>> {
    const { key } = this.resolvePath(ref, 'relative ref');
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty stream payload for ref "${ref}"`);

    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  private resolvePath(path: string, label: string): { ref: string; key: string } {
    if (!path || isAbsolute(path)) {
      throw new Error(`Expected ${label} inside the configured root.`);
    }

    const normalized = normalize(path);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error(`Expected ${label} inside the configured root.`);
    }

    const ref = normalizeRef(normalized);
    const key = this.prefix ? `${this.prefix}${ref}` : ref;
    return { ref, key };
  }
}

function normalizePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function normalizeRef(path: string): string {
  return path.split(/[/]+/).join('/');
}

export function resolveS3PayloadStoreOptionsFromEnv(
  overrides: Partial<S3PayloadStoreAdapterOptions> = {},
): S3PayloadStoreAdapterOptions {
  const bucket = overrides.bucket ?? process.env.TRACE_S3_BUCKET;
  if (!bucket) {
    throw new Error('TRACE_S3_BUCKET is required for S3PayloadStoreAdapter');
  }

  return {
    bucket,
    prefix: overrides.prefix ?? process.env.TRACE_S3_PREFIX,
    region: overrides.region ?? process.env.AWS_REGION,
    endpoint: overrides.endpoint ?? process.env.AWS_ENDPOINT_URL,
    client: overrides.client,
  };
}
