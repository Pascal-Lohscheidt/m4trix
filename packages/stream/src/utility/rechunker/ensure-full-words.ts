/**
 * A helper to be used with Pump.rechunk that ensures full word chunks.
 * Aggregates incoming chunks and emits only when a full word boundary is reached.
 */
export async function ensureFullWords({
  buffer,
  push,
  lastChunk,
}: {
  buffer: string[];
  push: (chunk: string) => void;
  lastChunk: boolean;
}): Promise<void> {
  const combined = buffer.join('');
  const lastBoundary = Math.max(
    combined.lastIndexOf(' '),
    combined.lastIndexOf('\n'),
    combined.lastIndexOf('\t')
  );

  if (lastBoundary !== -1 || lastChunk) {
    const emitPart =
      lastBoundary !== -1 ? combined.slice(0, lastBoundary + 1) : combined;
    const leftoverPart =
      lastBoundary !== -1 ? combined.slice(lastBoundary + 1) : '';

    if (emitPart.trim().length > 0) {
      push(emitPart);
    }

    buffer.length = 0;
    if (leftoverPart.length > 0) {
      buffer.push(leftoverPart);
    }
  }
}
