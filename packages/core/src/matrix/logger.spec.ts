// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Schema as S } from 'effect';
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from './agent-factory.js';
import {
  AgentNetwork,
  type AgentNetworkSetupOptions,
  consoleNetworkLogger,
  type NetworkLogger,
} from './agent-network/agent-network.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';
import type { Envelope } from './agent-network/event-plane.js';
import { RunLifecycleEvent } from './agent-network/run-lifecycle.js';
import type { AgentNetworkStore } from './agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './agent-network/stores/inmemory-network-store.js';
import { registerSSEStream } from './io/proxy-consumer.js';
import type { ExposedStream } from './io/types.js';
import type { NetworkTracer } from './tracing/network-tracer.js';
import { noopNetworkTracer } from './tracing/network-tracer.js';

const start = AgentNetworkEvent.of('start', S.Struct({}));
const answer = AgentNetworkEvent.of('answer', S.Struct({ text: S.String }));

type LogCall = { level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown };

function recordingLogger(): Required<NetworkLogger> & { calls: LogCall[] } {
  const calls: LogCall[] = [];
  const at =
    (level: LogCall['level']) =>
    (message: string, data?: unknown): void => {
      calls.push({ level, message, data });
    };
  return { calls, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

const post = (payload: unknown = {}): Request =>
  new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

/** start -> answer on client; `logic` decides what the agent does. */
function network(
  logic: Parameters<ReturnType<typeof answerAgent>['logic']>[0],
  options: AgentNetworkSetupOptions & {
    endsOn?: (envelope: { payload: { text: string } }) => boolean;
  },
) {
  const { endsOn: when, ...setup } = options;
  return AgentNetwork.setup(({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
    const client = createChannel('client').proxy(proxy.sse());
    registerAgent(answerAgent().logic(logic).produce({})).subscribe(mainChannel).publishTo(client);
    endsOn(answer, when);
  }, setup);
}

const answerAgent = () => AgentFactory.run().listensTo([start]).emits([answer]);

describe('injectable logger', () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) {
      consoleSpies.push(vi.spyOn(console, level).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.mockRestore();
  });

  const expectConsoleUntouched = (): void => {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  };

  test('a throwing endsOn predicate is reported to logger.warn', async () => {
    const logger = recordingLogger();
    const net = network(
      async ({ emit }) => {
        emit(answer.make({ text: 'a' }));
      },
      {
        logger,
        endsOn: () => {
          throw new Error('predicate bug');
        },
      },
    );
    const api = net.expose(registerSSEStream({ triggerEvents: [start], idleTimeout: '50 millis' }));

    await api.createStream({ request: post() }, collect);

    expect(logger.calls).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('endsOn(answer) predicate threw'),
      }),
    );
    expectConsoleUntouched();
  });

  test('a lifecycle event the store cannot keep is reported to logger.error', async () => {
    const logger = recordingLogger();
    const inner = createInMemoryNetworkStore();
    const store: AgentNetworkStore = {
      ...inner,
      append: async (key, event) => {
        if (event.name.startsWith('m4trix:')) throw new Error('db down');
        return inner.append(key, event);
      },
    };
    const net = network(
      async ({ emit }) => {
        emit(answer.make({ text: 'a' }));
      },
      { logger, store },
    );
    const api = net.expose(registerSSEStream({ triggerEvents: [start] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)?.name).toBe(RunLifecycleEvent.completed);
    expect(logger.calls).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining(`could not store ${RunLifecycleEvent.completed}`),
      }),
    );
    expectConsoleUntouched();
  });

  test("an event refused for another principal's run is reported to logger.warn", async () => {
    const logger = recordingLogger();
    const net = network(async () => {}, { logger });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const plane = yield* net.run();
          const main = net.getMainChannel()?.name;
          if (!main) throw new Error('no main channel');
          yield* plane.publish(main, {
            name: 'start',
            meta: { runId: 'r1', contextId: 'c1', principalId: 'alice' },
            payload: {},
          });
          const accepted = yield* plane.publish(main, {
            name: 'start',
            meta: { runId: 'r1', contextId: 'c1', principalId: 'mallory' },
            payload: {},
          });
          expect(accepted).toBe(false);
        }),
      ),
    );

    expect(logger.calls).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('the run belongs to another principal'),
      }),
    );
    expectConsoleUntouched();
  });

  test('invalid usage reports are reported to logger.warn', async () => {
    const logger = recordingLogger();
    const net = network(
      async ({ emit, reportUsage }) => {
        reportUsage({ inputTokens: -1 });
        emit(answer.make({ text: 'a' }));
      },
      { logger },
    );
    const api = net.expose(registerSSEStream({ triggerEvents: [start] }));

    await api.createStream({ request: post() }, collect);

    expect(logger.calls).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('reportUsage: ignoring invalid inputTokens'),
      }),
    );
    expectConsoleUntouched();
  });

  test('failing tracer hooks are reported to logger.warn', async () => {
    const logger = recordingLogger();
    const tracer: NetworkTracer = {
      ...noopNetworkTracer,
      onEventPublish: async () => {
        throw new Error('tracer down');
      },
    };
    const net = network(
      async ({ emit }) => {
        emit(answer.make({ text: 'a' }));
      },
      { logger, networkTracer: tracer },
    );
    const api = net.expose(registerSSEStream({ triggerEvents: [start] }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.at(-1)?.name).toBe(RunLifecycleEvent.completed);
    expect(logger.calls).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('network tracer onEventPublish failed'),
      }),
    );
    expectConsoleUntouched();
  });

  test('a logger with only warn gets errors as warnings', async () => {
    const warn = vi.fn();
    const inner = createInMemoryNetworkStore();
    const store: AgentNetworkStore = {
      ...inner,
      append: async (key, event) => {
        if (event.name.startsWith('m4trix:')) throw new Error('db down');
        return inner.append(key, event);
      },
    };
    const net = network(
      async ({ emit }) => {
        emit(answer.make({ text: 'a' }));
      },
      { logger: { warn }, store },
    );
    const api = net.expose(registerSSEStream({ triggerEvents: [start] }));

    await api.createStream({ request: post() }, collect);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`could not store ${RunLifecycleEvent.completed}`),
      expect.anything(),
    );
    expectConsoleUntouched();
  });

  test('a throwing logger never breaks the network', async () => {
    const logger: NetworkLogger = {
      warn: () => {
        throw new Error('logger down');
      },
    };
    const net = network(
      async ({ emit }) => {
        emit(answer.make({ text: 'a' }));
      },
      {
        logger,
        endsOn: () => {
          throw new Error('predicate bug');
        },
      },
    );
    const api = net.expose(registerSSEStream({ triggerEvents: [start], idleTimeout: '50 millis' }));

    const events = await api.createStream({ request: post() }, collect);

    expect(events.map((e) => e.name)).toEqual(['answer', RunLifecycleEvent.failed]);
  });

  test('the default logger writes to console', () => {
    consoleNetworkLogger.warn('w', { a: 1 });
    consoleNetworkLogger.error?.('e');
    expect(console.warn).toHaveBeenCalledWith('w', { a: 1 });
    expect(console.error).toHaveBeenCalledWith('e');
  });

  test('runtime code logs only through the logger (console only in the default logger and console tracers)', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const allowed = new Set(['matrix/logger.ts', 'matrix/console-tracer.ts']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.ts') || path.endsWith('.spec.ts')) continue;
        const relative = path.slice(root.length).replace(/\\/g, '/');
        if (allowed.has(relative)) continue;
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (!/\bconsole\.\w+\(/.test(line)) return;
            // The opt-in console tracer is console output by design.
            if (relative === 'matrix/tracing/network-tracer.ts' && line.includes('console.log('))
              return;
            offenders.push(`${relative}:${i + 1}: ${line.trim()}`);
          });
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  test('types: a leveled logger, the minimal { warn } shape and console all fit', () => {
    expectTypeOf<NetworkLogger['warn']>().toEqualTypeOf<
      (message: string, data?: unknown) => void
    >();
    expectTypeOf<NetworkLogger>().toHaveProperty('debug');
    expectTypeOf<NetworkLogger>().toHaveProperty('info');
    expectTypeOf<NetworkLogger>().toHaveProperty('error');
    expectTypeOf({ warn: (_message: string) => {} }).toMatchTypeOf<NetworkLogger>();
    expectTypeOf(console).toMatchTypeOf<NetworkLogger>();
    expectTypeOf<AgentNetworkSetupOptions['logger']>().toEqualTypeOf<NetworkLogger | undefined>();
  });
});
