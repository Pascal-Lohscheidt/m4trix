import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

/** Write to a unique temp file beside the target, then rename for atomic publish. */
export async function writeFileAtomic(absolutePath: string, data: string | Buffer): Promise<void> {
  const tmpPath = `${absolutePath}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, absolutePath);
}
