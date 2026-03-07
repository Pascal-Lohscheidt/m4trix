import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as jitiModule from 'jiti';

import type { RunnerConfigOverrides } from './config';
import {
  toRunnerConfigOverrides,
  type ConfigType,
  type M4trixEvalConfigFactory,
} from './config';

const CONFIG_FILE_NAME = 'm4trix-eval.config.ts';

type JitiLoader = {
  (id: string): unknown;
  import?: (id: string) => Promise<unknown> | unknown;
};

let cachedLoader: JitiLoader | undefined;

function getJitiLoader(): JitiLoader {
  if (cachedLoader) {
    return cachedLoader;
  }
  const createJiti =
    (jitiModule as { createJiti?: unknown; default?: unknown }).createJiti ??
    (jitiModule as { default?: unknown }).default;
  if (typeof createJiti !== 'function') {
    throw new Error(
      'Failed to initialize jiti for m4trix eval config loading.',
    );
  }
  cachedLoader = (
    createJiti as (id: string, options?: Record<string, unknown>) => JitiLoader
  )(import.meta.url, {
    interopDefault: true,
    moduleCache: true,
  });
  return cachedLoader;
}

function resolveConfigModuleExport(loadedModule: unknown): unknown {
  if (
    loadedModule &&
    typeof loadedModule === 'object' &&
    'default' in loadedModule
  ) {
    return (loadedModule as { default: unknown }).default;
  }
  return loadedModule;
}

function resolveConfigValue(value: unknown): ConfigType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'function') {
    return (value as M4trixEvalConfigFactory<ConfigType>)();
  }
  if (typeof value !== 'object') {
    throw new Error(
      'Invalid m4trix eval config export. Expected an object or defineConfig(() => config).',
    );
  }
  return value as ConfigType;
}

export function loadRunnerConfigFile(
  cwd = process.cwd(),
): RunnerConfigOverrides | undefined {
  const configPath = resolve(cwd, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return undefined;
  }
  const loader = getJitiLoader();
  const loaded = loader(configPath);
  const exportedValue = resolveConfigModuleExport(loaded);
  const config = resolveConfigValue(exportedValue);
  return toRunnerConfigOverrides(config);
}
