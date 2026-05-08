import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsTraceViewerApi } from './fs-setup';

describe('createFsTraceViewerApi', () => {
  it('lists empty traces for a fresh directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm4trix-trace-viewer-'));
    const api = createFsTraceViewerApi(dir);
    await expect(api.listTraces()).resolves.toEqual({ traces: [] });
  });
});
