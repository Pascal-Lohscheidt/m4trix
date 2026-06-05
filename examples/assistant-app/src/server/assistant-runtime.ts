import { resolve } from 'node:path';
import { Effect, Scope } from 'effect';
import type { EventPlane } from '@m4trix/core/matrix';
import { withAgentMemory } from '../network/depedency-layers/with-agent-memory.js';
import { withFileSystem } from '../network/depedency-layers/with-file-system.js';
import { withTavelyWebsearch } from '../network/depedency-layers/tavely-websearch.js';
import { network } from '../network/network.js';

let planeInstance: EventPlane | undefined;
let startPromise: Promise<EventPlane> | undefined;

export const dependencyLayers = {
  WithTavelyWebsearchLayer: withTavelyWebsearch,
  WithFileSystemLayer: withFileSystem({ rootDir: resolve(process.cwd(), 'agent-tmp') }),
  WithAgentMemoryLayer: withAgentMemory(),
};

/**
 * One event plane and subscriber set for the whole server process.
 *
 * `network.run()` forks agent loops that must outlive the `run()` effect. A
 * background fiber owns the scope and never completes, so later chat turns reuse
 * the same subscribers instead of starting/stopping planes per request.
 */
export function startServerRuntime(): Promise<EventPlane> {
  if (planeInstance) {
    return Promise.resolve(planeInstance);
  }

  // Run the lifetime fiber directly — do NOT fork from a parent effect that completes.
  // When the parent runPromise returned previously, Effect interrupted the fork and
  // killed all agent subscribers (zero events on the client channel).
  startPromise ??= new Promise<EventPlane>((resolve, reject) => {
    const tracingLayer = network.getTracingLayer();
    const lifetime = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const plane = yield* network
        .run({ layers: dependencyLayers })
        .pipe(Effect.provideService(Scope.Scope, scope));
      planeInstance = plane;
      resolve(plane);
      yield* Effect.never;
    });
    const runnable = tracingLayer ? lifetime.pipe(Effect.provide(tracingLayer)) : lifetime;
    Effect.runPromise(runnable).catch(reject);
  });

  return startPromise;
}

export function getServerPlane(): EventPlane {
  if (!planeInstance) {
    throw new Error('Server runtime not started');
  }
  return planeInstance;
}
