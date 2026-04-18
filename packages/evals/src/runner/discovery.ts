import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Dataset } from '../evals/dataset.js';
import type { Evaluator } from '../evals/evaluator.js';
import type { RunConfig } from '../evals/run-config.js';
import type { TestCase } from '../evals/test-case.js';
import type { RunnerDiscoveryConfig } from './config.js';
import type {
  CollectedDataset,
  CollectedEvaluator,
  CollectedRunConfig,
  CollectedTestCase,
} from './events.js';

type JitiModuleLoader = {
  (id: string): unknown;
  import?: (id: string) => Promise<unknown> | unknown;
};

let jitiLoader: JitiModuleLoader | undefined;

function toId(prefix: string, filePath: string, name?: string): string {
  const stable = name && name.trim().length > 0 ? name : filePath;
  return `${prefix}:${stable}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasMethod(value: unknown, methodName: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    methodName in value &&
    typeof (value as Record<string, unknown>)[methodName] === 'function'
  );
}

function isDatasetLike(value: unknown): value is Dataset {
  return hasMethod(value, 'getName') && hasMethod(value, 'matchesTestCase');
}

function isEvaluatorLike(value: unknown): value is Evaluator<unknown, unknown, unknown, unknown> {
  return (
    hasMethod(value, 'getName') &&
    hasMethod(value, 'resolveContext') &&
    hasMethod(value, 'getEvaluateFn')
  );
}

function isRunConfigLike(value: unknown): value is RunConfig {
  return (
    hasMethod(value, 'getName') &&
    hasMethod(value, 'getRuns') &&
    typeof (value as RunConfig).getRuns === 'function'
  );
}

function isTestCaseLike(value: unknown): value is TestCase<unknown> {
  return hasMethod(value, 'getName') && hasMethod(value, 'getTags') && hasMethod(value, 'getInput');
}

/** Top-level exports may be test cases or arrays of test cases (e.g. `export const testCases = [...]`). */
function collectTestCasesFromExportValues(exports: unknown[]): TestCase<unknown>[] {
  const out: TestCase<unknown>[] = [];
  for (const value of exports) {
    if (isTestCaseLike(value)) {
      out.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isTestCaseLike(item)) {
          out.push(item);
        }
      }
    }
  }
  return out;
}

async function walkDirectory(
  rootDir: string,
  excludeDirectories: ReadonlyArray<string>,
): Promise<string[]> {
  const out: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absolute = resolve(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (excludeDirectories.includes(entry.name)) {
            return;
          }
          await walk(absolute);
          return;
        }

        if (entry.isFile()) {
          out.push(absolute);
        }
      }),
    );
  }

  await walk(rootDir);
  return out;
}

function hasOneSuffix(filePath: string, suffixes: ReadonlyArray<string>): boolean {
  return suffixes.some((suffix) => filePath.endsWith(suffix));
}

async function loadModuleExports(filePath: string): Promise<unknown[]> {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    if (!jitiLoader) {
      const jitiModule = (await import('jiti')) as unknown as {
        createJiti?: (filename: string, opts?: Record<string, unknown>) => JitiModuleLoader;
        default?: (filename: string, opts?: Record<string, unknown>) => JitiModuleLoader;
      };
      const createJiti = jitiModule.createJiti ?? jitiModule.default;
      if (!createJiti) {
        throw new Error('Failed to initialize jiti TypeScript loader');
      }
      jitiLoader = createJiti(import.meta.url, {
        interopDefault: true,
        moduleCache: true,
      }) as JitiModuleLoader;
    }
    const loaded = jitiLoader.import
      ? await jitiLoader.import(filePath)
      : await Promise.resolve(jitiLoader(filePath));
    return Object.values(loaded as Record<string, unknown>);
  }

  const moduleUrl = pathToFileURL(filePath).href;
  const loaded = (await import(moduleUrl)) as Record<string, unknown>;
  return Object.values(loaded);
}

export async function collectDatasetsFromFiles(
  config: RunnerDiscoveryConfig,
): Promise<ReadonlyArray<CollectedDataset>> {
  const files = await walkDirectory(config.rootDir, config.excludeDirectories);
  const matched = files.filter((filePath) => hasOneSuffix(filePath, config.datasetSuffixes));

  const found = await Promise.all(
    matched.map(async (absolutePath) => {
      const exports = await loadModuleExports(absolutePath);
      const datasets = exports.filter(isDatasetLike);
      const relPath = relative(config.rootDir, absolutePath);
      return datasets.map((dataset) => ({
        id: toId('dataset', relPath, dataset.getName()),
        filePath: relPath,
        dataset,
      }));
    }),
  );

  return found.flat();
}

export async function collectEvaluatorsFromFiles(
  config: RunnerDiscoveryConfig,
): Promise<ReadonlyArray<CollectedEvaluator>> {
  const files = await walkDirectory(config.rootDir, config.excludeDirectories);
  const matched = files.filter((filePath) => hasOneSuffix(filePath, config.evaluatorSuffixes));

  const found = await Promise.all(
    matched.map(async (absolutePath) => {
      const exports = await loadModuleExports(absolutePath);
      const evaluators = exports.filter(isEvaluatorLike);
      const relPath = relative(config.rootDir, absolutePath);
      return evaluators.map((evaluator) => ({
        id: toId('evaluator', relPath, evaluator.getName()),
        filePath: relPath,
        evaluator,
      }));
    }),
  );

  return found.flat();
}

export async function collectRunConfigsFromFiles(
  config: RunnerDiscoveryConfig,
): Promise<ReadonlyArray<CollectedRunConfig>> {
  const files = await walkDirectory(config.rootDir, config.excludeDirectories);
  const matched = files.filter((filePath) => hasOneSuffix(filePath, config.runConfigSuffixes));

  const found = await Promise.all(
    matched.map(async (absolutePath) => {
      const exports = await loadModuleExports(absolutePath);
      const runConfigs = exports.filter(isRunConfigLike);
      const relPath = relative(config.rootDir, absolutePath);
      return runConfigs.map((runConfig) => ({
        id: runConfig.getName(),
        filePath: relPath,
        runConfig,
      }));
    }),
  );

  return found.flat();
}

export async function collectTestCasesFromFiles(
  config: RunnerDiscoveryConfig,
): Promise<ReadonlyArray<CollectedTestCase>> {
  const files = await walkDirectory(config.rootDir, config.excludeDirectories);
  const matched = files.filter((filePath) => hasOneSuffix(filePath, config.testCaseSuffixes));

  const found = await Promise.all(
    matched.map(async (absolutePath) => {
      const exports = await loadModuleExports(absolutePath);
      const testCases = collectTestCasesFromExportValues(exports);
      const relPath = relative(config.rootDir, absolutePath);
      return testCases.map((testCase) => ({
        id: toId('test-case', relPath, testCase.getName()),
        filePath: relPath,
        testCase,
      }));
    }),
  );

  return found.flat();
}
