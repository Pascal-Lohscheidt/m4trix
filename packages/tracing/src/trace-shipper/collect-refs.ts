import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceRun } from '../types.js';
import { toRef } from './paths.js';

export async function readRunsFile(localPath: string): Promise<TraceRun[]> {
  const content = await readFile(localPath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceRun);
}

export function collectPayloadRefs(runs: TraceRun[]): string[] {
  const refs = new Set<string>();
  for (const run of runs) {
    if (run.inputRef) refs.add(run.inputRef);
    if (run.outputRef) refs.add(run.outputRef);
    if (run.eventsRef) refs.add(run.eventsRef);
  }
  return [...refs];
}

/**
 * A payload is replicated once its local file is gone: the tracer writes a payload before any run
 * that references it, and the shipper deletes it only after a successful upload.
 */
export async function payloadRefsReplicated(root: string, refs: string[]): Promise<boolean> {
  for (const ref of refs) {
    const localPath = join(root, ref);
    toRef(root, localPath); // throws for refs that escape the root
    try {
      await access(localPath);
      return false;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return true;
}
