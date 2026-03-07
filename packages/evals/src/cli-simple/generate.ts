import React from 'react';
import { render } from 'ink';
import { writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

import type { RunnerApi } from '../runner';
import { GenerateView } from './views/GenerateView';

interface GeneratedDatasetCase {
  name: string;
  input: unknown;
  output?: unknown;
}

function readOutput(testCase: { getOutput?: () => unknown }): unknown {
  if (typeof testCase.getOutput !== 'function') {
    return undefined;
  }
  return testCase.getOutput();
}

function createOutputPath(datasetFilePath: string): string {
  const parsed = parse(datasetFilePath);
  return join(parsed.dir, `${parsed.name}.cases.json`);
}

export async function generateDatasetJsonCommandPlain(
  runner: RunnerApi,
  datasetName: string,
): Promise<void> {
  const dataset = await runner.resolveDatasetByName(datasetName);
  if (!dataset) {
    throw new Error(`Dataset "${datasetName}" not found.`);
  }

  const testCases = await runner.collectDatasetTestCases(dataset.id);
  const payload: GeneratedDatasetCase[] = testCases.map((item) => ({
    name: item.testCase.getName(),
    input: item.testCase.getInput(),
    output: readOutput(item.testCase),
  }));

  const absoluteDatasetPath = resolve(process.cwd(), dataset.filePath);
  const outputPath = createOutputPath(absoluteDatasetPath);

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Generated ${payload.length} test cases for dataset "${dataset.dataset.getName()}".`);
  console.log(`Wrote ${outputPath}`);
}

export async function generateDatasetJsonCommandInk(
  runner: RunnerApi,
  datasetName: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const app = render(
      React.createElement(GenerateView, {
        runner,
        datasetName,
        onComplete: (err) => {
          app.unmount();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      }),
    );
  });
}
