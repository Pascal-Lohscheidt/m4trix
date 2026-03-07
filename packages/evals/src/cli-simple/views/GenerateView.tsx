/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import type { RunnerApi } from '../../runner';
import { Banner } from './Banner';

interface GenerateViewProps {
  runner: RunnerApi;
  datasetName: string;
  onComplete: (error?: Error) => void;
}

export function GenerateView({
  runner,
  datasetName,
  onComplete,
}: GenerateViewProps): React.ReactNode {
  const [result, setResult] = useState<{
    count: number;
    datasetName: string;
    outputPath: string;
  } | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const dataset = await runner.resolveDatasetByName(datasetName);
      if (!dataset) {
        setError(new Error(`Dataset "${datasetName}" not found.`));
        onComplete(new Error(`Dataset "${datasetName}" not found.`));
        return;
      }

      const { writeFile } = await import('node:fs/promises');
      const { join, parse, resolve } = await import('node:path');

      const testCases = await runner.collectDatasetTestCases(dataset.id);
      const payload = testCases.map((item) => {
        const tc = item.testCase as { getOutput?: () => unknown };
        return {
          name: item.testCase.getName(),
          input: item.testCase.getInput(),
          output: typeof tc.getOutput === 'function' ? tc.getOutput() : undefined,
        };
      });

      const absoluteDatasetPath = resolve(process.cwd(), dataset.filePath);
      const parsed = parse(absoluteDatasetPath);
      const outputPath = join(parsed.dir, `${parsed.name}.cases.json`);

      await writeFile(
        outputPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );

      if (!cancelled) {
        setResult({
          count: payload.length,
          datasetName: dataset.dataset.getName(),
          outputPath,
        });
        setTimeout(() => onComplete(), 200);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [runner, datasetName, onComplete]);

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Banner />
        <Text color="red">{error.message}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Banner />
      </Box>
      {result && (
        <Box flexDirection="column">
          <Text color="green">
            Generated {result.count} test cases for dataset "{result.datasetName}".
          </Text>
          <Text color="gray">Wrote {result.outputPath}</Text>
        </Box>
      )}
    </Box>
  );
}
