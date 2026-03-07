export interface RunnerDiscoveryConfig {
  rootDir: string;
  datasetSuffixes: ReadonlyArray<string>;
  evaluatorSuffixes: ReadonlyArray<string>;
  testCaseSuffixes: ReadonlyArray<string>;
  excludeDirectories: ReadonlyArray<string>;
}

export interface RunnerConfig {
  discovery: RunnerDiscoveryConfig;
  artifactDirectory: string;
  /** Max concurrent test cases per run. Default: 1 (sequential). */
  maxConcurrency: number;
}

export type RunnerConfigOverrides = Omit<Partial<RunnerConfig>, 'discovery'> & {
  discovery?: Partial<RunnerDiscoveryConfig>;
};

export interface M4trixEvalConfigDiscovery {
  rootDir?: string;
  datasetFilePatterns?: ReadonlyArray<string>;
  evaluatorFilePatterns?: ReadonlyArray<string>;
  testCaseFilePatterns?: ReadonlyArray<string>;
  datasetSuffixes?: ReadonlyArray<string>;
  evaluatorSuffixes?: ReadonlyArray<string>;
  testCaseSuffixes?: ReadonlyArray<string>;
  excludeDirectories?: ReadonlyArray<string>;
}

export interface M4trixEvalConfig {
  discovery?: M4trixEvalConfigDiscovery;
  artifactDirectory?: string;
  /** Max concurrent test cases per run. Default: 1 (sequential). */
  maxConcurrency?: number;
}

export type ConfigType = M4trixEvalConfig;

export type M4trixEvalConfigFactory<TConfig extends ConfigType = ConfigType> = () => TConfig;

export function defineConfig<TConfig extends ConfigType>(
  factory: M4trixEvalConfigFactory<TConfig>,
): M4trixEvalConfigFactory<TConfig> {
  return factory;
}

export const defaultRunnerConfig: RunnerConfig = {
  discovery: {
    rootDir: process.cwd(),
    datasetSuffixes: ['.dataset.ts', '.dataset.tsx', '.dataset.js', '.dataset.mjs'],
    evaluatorSuffixes: [
      '.evaluator.ts',
      '.evaluator.tsx',
      '.evaluator.js',
      '.evaluator.mjs',
    ],
    testCaseSuffixes: [
      '.test-case.ts',
      '.test-case.tsx',
      '.test-case.js',
      '.test-case.mjs',
    ],
    excludeDirectories: ['node_modules', 'dist', '.next', '.git', '.pnpm-store'],
  },
  artifactDirectory: '.eval-results',
  maxConcurrency: 1,
};

export function toRunnerConfigOverrides(
  config?: ConfigType,
): RunnerConfigOverrides | undefined {
  if (!config) {
    return undefined;
  }

  const rawDiscovery = config.discovery;
  const discovery: Partial<RunnerDiscoveryConfig> = {};
  if (rawDiscovery?.rootDir !== undefined) {
    discovery.rootDir = rawDiscovery.rootDir;
  }
  if (rawDiscovery?.datasetFilePatterns !== undefined) {
    discovery.datasetSuffixes = rawDiscovery.datasetFilePatterns;
  } else if (rawDiscovery?.datasetSuffixes !== undefined) {
    discovery.datasetSuffixes = rawDiscovery.datasetSuffixes;
  }
  if (rawDiscovery?.evaluatorFilePatterns !== undefined) {
    discovery.evaluatorSuffixes = rawDiscovery.evaluatorFilePatterns;
  } else if (rawDiscovery?.evaluatorSuffixes !== undefined) {
    discovery.evaluatorSuffixes = rawDiscovery.evaluatorSuffixes;
  }
  if (rawDiscovery?.testCaseFilePatterns !== undefined) {
    discovery.testCaseSuffixes = rawDiscovery.testCaseFilePatterns;
  } else if (rawDiscovery?.testCaseSuffixes !== undefined) {
    discovery.testCaseSuffixes = rawDiscovery.testCaseSuffixes;
  }
  if (rawDiscovery?.excludeDirectories !== undefined) {
    discovery.excludeDirectories = rawDiscovery.excludeDirectories;
  }

  const overrides: RunnerConfigOverrides = {};
  if (config.artifactDirectory !== undefined) {
    overrides.artifactDirectory = config.artifactDirectory;
  }
  if (config.maxConcurrency !== undefined) {
    overrides.maxConcurrency = config.maxConcurrency;
  }
  if (Object.keys(discovery).length > 0) {
    overrides.discovery = discovery;
  }
  return overrides;
}

export function withRunnerConfig(overrides?: RunnerConfigOverrides): RunnerConfig {
  if (!overrides) {
    return defaultRunnerConfig;
  }
  const discovery = overrides.discovery
    ? {
        ...defaultRunnerConfig.discovery,
        ...overrides.discovery,
      }
    : defaultRunnerConfig.discovery;

  return {
    ...defaultRunnerConfig,
    ...overrides,
    discovery,
  };
}
