import type { RunNode } from '../../../../types';

export function testRun(
  partial: Partial<RunNode> & Pick<RunNode, 'runId' | 'name' | 'type'>,
): RunNode {
  return {
    status: 'success',
    startTime: 't0',
    ...partial,
    children: partial.children ?? [],
  };
}
