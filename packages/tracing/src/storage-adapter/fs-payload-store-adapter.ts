import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { PayloadStoreAdapter } from '../types.js';

export type FsPayloadStoreAdapterOptions = {
  path: string;
};

export class FsPayloadStoreAdapter implements PayloadStoreAdapter {
  private readonly rootPath: string;

  constructor(options: FsPayloadStoreAdapterOptions) {
    this.rootPath = resolve(options.path);
  }

  async putJson(path: string, value: unknown): Promise<string> {
    const { absolutePath, ref } = this.resolvePath(path, 'relative path');
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    return ref;
  }

  async getJson<T = unknown>(ref: string): Promise<T> {
    const { absolutePath } = this.resolvePath(ref, 'relative ref');
    return JSON.parse(await readFile(absolutePath, 'utf-8')) as T;
  }

  async putStream(
    path: string,
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }

    const { absolutePath, ref } = this.resolvePath(path, 'relative path');
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.concat(chunks));
    return ref;
  }

  async getStream(ref: string): Promise<ReadableStream<Uint8Array>> {
    const { absolutePath } = this.resolvePath(ref, 'relative ref');
    const bytes = await readFile(absolutePath);

    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  private resolvePath(path: string, label: string): { absolutePath: string; ref: string } {
    if (!path || isAbsolute(path)) {
      throw new Error(`Expected ${label} inside the configured root.`);
    }

    const normalized = normalize(path);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error(`Expected ${label} inside the configured root.`);
    }

    const absolutePath = resolve(this.rootPath, normalized);
    const relativePath = relative(this.rootPath, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Expected ${label} inside the configured root.`);
    }

    return {
      absolutePath,
      ref: normalizeRef(relativePath),
    };
  }
}

function normalizeRef(path: string): string {
  return path.split(/[/]+/).join('/');
}
