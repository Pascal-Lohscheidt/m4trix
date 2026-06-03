import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DepedencyLayer, S } from '@m4trix/core';

export type FileSystemEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
};

export type FileSystemLayer = {
  resolvePath: (path: string) => string;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
  listDirectory: (path?: string) => Promise<FileSystemEntry[]>;
  fileExists: (path: string) => Promise<boolean>;
};

export const WithFileSystemLayer = DepedencyLayer.of({
  name: 'WithFileSystemLayer',
  config: S.Struct({ rootDir: S.String }),
}).define<FileSystemLayer>();

function createPathResolver(rootDir: string): (path: string) => string {
  const root = resolve(rootDir);

  return (path: string): string => {
    const target = resolve(root, path);
    const relativePath = relative(root, target);

    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Path is outside filesystem root: ${path}`);
    }

    return target;
  };
}

function toEntry(rootDir: string, entryPath: string, type: FileSystemEntry['type']): FileSystemEntry {
  return {
    name: basename(entryPath),
    path: relative(rootDir, entryPath),
    type,
  };
}

export function withFileSystem(options?: { rootDir?: string }) {
  const rootDir = resolve(options?.rootDir ?? process.cwd());
  const resolvePath = createPathResolver(rootDir);

  return WithFileSystemLayer.make({
    config: { rootDir },
    resolvePath,
    readTextFile: async (path) => readFile(resolvePath(path), 'utf8'),
    writeTextFile: async (path, contents) => {
      const targetPath = resolvePath(path);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, contents, 'utf8');
    },
    listDirectory: async (path = '.') => {
      const directoryPath = resolvePath(path);
      const entries = await readdir(directoryPath, { withFileTypes: true });

      return entries.map((entry) => {
        const entryPath = resolve(directoryPath, entry.name);
        const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
        return toEntry(rootDir, entryPath, type);
      });
    },
    fileExists: async (path) => {
      try {
        await stat(resolvePath(path));
        return true;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    },
  });
}
