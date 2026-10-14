import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocsRun } from './types';

/**
 * Reads recorded runs from `content/runs/<id>.json` (written by `pnpm --filter website
 * docs:record`). Server only.
 */

export const RUNS_DIR = path.join(process.cwd(), 'content/runs');

class RunError extends Error {
  constructor(id: string, message: string) {
    super(`Run "${id}": ${message}`);
    this.name = 'RunError';
  }
}

/** Absolute path of a recording; rejects anything outside `content/runs`. */
export function runPath(id: string): string {
  if (!id || path.isAbsolute(id) || id.endsWith('.json')) {
    throw new RunError(
      id,
      'expected an id relative to content/runs without .json, e.g. "concepts/channels"',
    );
  }
  const absolute = path.resolve(RUNS_DIR, `${id}.json`);
  const relative = path.relative(RUNS_DIR, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RunError(id, 'path escapes content/runs');
  }
  return absolute;
}

const cache = new Map<string, Promise<DocsRun>>();

async function read(id: string): Promise<DocsRun> {
  const file = runPath(id);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RunError(
        id,
        `no recording at content/runs/${id}.json. Export \`network\` and \`scenario\` from content/snippets/${id}.ts and run \`pnpm --filter website docs:record\`.`,
      );
    }
    throw error;
  }
  const run = JSON.parse(text) as DocsRun;
  if (run.version !== 1) throw new RunError(id, `unsupported recording version ${run.version}`);
  if (run.walkthrough.length !== run.events.length) {
    throw new RunError(id, 'walkthrough and events differ in length; re-record the run');
  }
  return run;
}

/** Loads a recording. Cached per process in production; re-read in development. */
export function loadRun(id: string): Promise<DocsRun> {
  if (process.env.NODE_ENV === 'development') return read(id);
  let run = cache.get(id);
  if (!run) {
    run = read(id).catch((error: unknown) => {
      cache.delete(id);
      throw error;
    });
    cache.set(id, run);
  }
  return run;
}
