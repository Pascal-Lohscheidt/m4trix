import { readFile } from 'node:fs/promises';
import type { TraceRun } from '../types.js';

export async function collectStructurePayloadRefs(
  localPath: string,
  kind: string,
): Promise<string[]> {
  if (kind === 'structure-trace') {
    return [];
  }

  const content = await readFile(localPath, 'utf-8');
  const runs = content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceRun);

  const refs = new Set<string>();
  for (const run of runs) {
    if (run.inputRef) refs.add(run.inputRef);
    if (run.outputRef) refs.add(run.outputRef);
    if (run.eventsRef) refs.add(run.eventsRef);
  }
  return [...refs];
}

export function payloadRefsUploaded(
  refs: string[],
  state: { payloads: Record<string, true> },
): boolean {
  return refs.every((ref) => state.payloads[ref] === true);
}
