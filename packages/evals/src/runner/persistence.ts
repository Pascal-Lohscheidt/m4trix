import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Effect, Queue } from 'effect';

export interface PersistenceMessage {
  runId: string;
  artifactPath: string;
  payload: unknown;
}

async function appendJsonLine(
  artifactPath: string,
  payload: unknown,
): Promise<void> {
  await mkdir(dirname(artifactPath), { recursive: true });
  await appendFile(artifactPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export const createPersistenceWorker = (
  queue: Queue.Queue<PersistenceMessage>,
): Effect.Effect<never, never, never> =>
  Effect.forever(
    Effect.gen(function* () {
      const message = yield* Queue.take(queue);
      yield* Effect.promise(() =>
        appendJsonLine(message.artifactPath, {
          runId: message.runId,
          ts: Date.now(),
          ...(typeof message.payload === 'object' &&
          message.payload !== null &&
          !Array.isArray(message.payload)
            ? message.payload
            : {}),
        }),
      );
    }),
  );
