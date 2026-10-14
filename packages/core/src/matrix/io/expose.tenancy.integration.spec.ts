import { Effect, Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { AgentFactory } from '../agent-factory.js';
import { AgentNetwork, type AgentNetworkSetupOptions } from '../agent-network/agent-network.js';
import { AgentNetworkEvent } from '../agent-network/agent-network-event.js';
import type { Envelope } from '../agent-network/event-plane.js';
import { RunLifecycleEvent } from '../agent-network/run-lifecycle.js';
import type { AgentNetworkStore } from '../agent-network/stores/agent-network-store.js';
import { createInMemoryNetworkStore } from '../agent-network/stores/inmemory-network-store.js';
import { ChannelName } from '../identifiers/channel-name.js';
import type { Principal } from '../principal.js';
import { Tool } from '../tool.js';
import { ExposeAuthError } from './expose.js';
import { type PublishInboundOptions, registerSSEStream } from './proxy-consumer.js';
import type { AuthResult, ExposedStream, ExposeRequest, OnRequestContext } from './types.js';

const messageEvent = AgentNetworkEvent.of('message', S.Struct({ text: S.String }));
const replyEvent = AgentNetworkEvent.of(
  'reply',
  S.Struct({ seen: S.Array(S.String), principalId: S.NullOr(S.String) }),
);

async function collect(stream: ExposedStream): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for await (const envelope of stream) out.push(envelope);
  return out;
}

function post(text: string, user?: string): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(user !== undefined && { 'x-user': user }),
    },
    body: JSON.stringify({ text }),
  });
}

/** Trusts the `x-user` header as the principal; requests without one are anonymous. */
const headerAuth = (req: ExposeRequest): AuthResult => {
  const user = req.request?.headers.get('x-user');
  return user ? { allowed: true, principal: { id: user, role: 'member' } } : { allowed: true };
};

/**
 * An agent that replies with every message it can see in the context's history (so a leak
 * between principals shows up in the reply) and the principal it runs for.
 */
function historyNetwork(options: AgentNetworkSetupOptions = {}) {
  const principals: Array<Principal | undefined> = [];
  const network = AgentNetwork.setup(
    ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
      const client = createChannel('client').proxy(proxy.sse());
      const agent = AgentFactory.run()
        .listensTo([messageEvent])
        .emits([replyEvent])
        .logic(async ({ history, principal, emit }) => {
          principals.push(principal);
          const seen = (await history.context()).events
            .filter(messageEvent.is)
            .map((e) => e.payload.text);
          emit(replyEvent.make({ seen, principalId: principal?.id ?? null }));
        })
        .produce({});
      registerAgent(agent).subscribe(mainChannel).publishTo(client);
      endsOn(replyEvent);
    },
    options,
  );
  return { network, principals };
}

function replyOf(events: Envelope[]): { seen: string[]; principalId: string | null } {
  const reply = events.find(replyEvent.is);
  if (!reply) throw new Error(`no reply in ${events.map((e) => e.name).join(', ')}`);
  return { seen: [...reply.payload.seen], principalId: reply.payload.principalId };
}

describe('expose tenancy', () => {
  describe('history is namespaced by principal', () => {
    test('principal B cannot read principal A history under the same contextId', async () => {
      const store = createInMemoryNetworkStore();
      const { network } = historyNetwork({ store });
      const api = network.expose(
        registerSSEStream({ triggerEvents: [messageEvent], auth: headerAuth }),
      );
      const ask = (text: string, user: string) =>
        api.createStream({ request: post(text, user), contextId: 'shared-ctx' }, collect);

      const alice1 = replyOf(await ask('alice secret', 'alice'));
      const bob = replyOf(await ask('bob question', 'bob'));
      const alice2 = replyOf(await ask('alice again', 'alice'));

      expect(alice1).toEqual({ seen: ['alice secret'], principalId: 'alice' });
      expect(bob).toEqual({ seen: ['bob question'], principalId: 'bob' });
      expect(alice2).toEqual({ seen: ['alice secret', 'alice again'], principalId: 'alice' });
      const names = async (namespace: string) =>
        (await store.readContext({ namespace, contextId: 'shared-ctx' })).events.map((e) =>
          messageEvent.is(e) ? e.payload.text : e.name,
        );
      expect(await names('principal:alice')).toEqual([
        'alice secret',
        'reply',
        RunLifecycleEvent.completed,
        'alice again',
        'reply',
        RunLifecycleEvent.completed,
      ]);
      expect(await names('principal:bob')).toEqual([
        'bob question',
        'reply',
        RunLifecycleEvent.completed,
      ]);
      expect(
        (await store.readContext({ namespace: 'anonymous', contextId: 'shared-ctx' })).events,
      ).toEqual([]);
    });

    test('anonymous requests share history only within the anonymous namespace', async () => {
      const { network } = historyNetwork();
      const api = network.expose(
        registerSSEStream({ triggerEvents: [messageEvent], auth: headerAuth }),
      );
      const ask = (text: string, user?: string) =>
        api.createStream({ request: post(text, user), contextId: 'ctx' }, collect);

      const first = replyOf(await ask('anon one'));
      const second = replyOf(await ask('anon two'));
      const carol = replyOf(await ask('carol', 'carol'));

      expect(first).toEqual({ seen: ['anon one'], principalId: null });
      expect(second).toEqual({ seen: ['anon one', 'anon two'], principalId: null });
      expect(carol).toEqual({ seen: ['carol'], principalId: 'carol' });
    });

    test('without auth every request is anonymous (shared by contextId, as before)', async () => {
      const { network } = historyNetwork();
      const api = network.expose(registerSSEStream({ triggerEvents: [messageEvent] }));
      const ask = (text: string, user: string) =>
        api.createStream({ request: post(text, user), contextId: 'ctx' }, collect);

      await ask('first', 'alice');
      const second = replyOf(await ask('second', 'bob'));

      // `x-user` means nothing without auth: both requests are anonymous.
      expect(second).toEqual({ seen: ['first', 'second'], principalId: null });
    });
  });

  describe('principal flow', () => {
    test('meta.principalId is stamped on every event; agents get the full principal', async () => {
      const { network, principals } = historyNetwork();
      const api = network.expose(
        registerSSEStream({ triggerEvents: [messageEvent], auth: headerAuth }),
      );

      const events = await api.createStream(
        { request: post('hi', 'alice'), contextId: 'ctx' },
        collect,
      );

      expect(events.map((e) => e.name)).toEqual(['reply', RunLifecycleEvent.completed]);
      expect(events.map((e) => e.meta.principalId)).toEqual(['alice', 'alice']);
      expect(principals).toEqual([{ id: 'alice', role: 'member' }]);
    });

    test('tools get the principal of the run', async () => {
      const seenByTool: Array<Principal | undefined> = [];
      const whoami = Tool.of({ name: 'whoami', description: 'Who is asking' })
        .input(S.Struct({}))
        .output(S.String)
        .define(({ principal }) => {
          expectTypeOf(principal).toEqualTypeOf<Principal | undefined>();
          seenByTool.push(principal);
          return principal?.id ?? 'nobody';
        });
      const network = AgentNetwork.setup(
        ({ mainChannel, createChannel, proxy, registerAgent, endsOn }) => {
          const client = createChannel('client').proxy(proxy.sse());
          const agent = AgentFactory.run()
            .listensTo([messageEvent])
            .emits([replyEvent])
            .tools(whoami)
            .logic(async ({ tools, emit }) => {
              const [tool] = tools.toTools();
              const id = (await tool?.execute({})) as string;
              emit(replyEvent.make({ seen: [], principalId: id }));
            })
            .produce({});
          registerAgent(agent).subscribe(mainChannel).publishTo(client);
          endsOn(replyEvent);
        },
      );
      const api = network.expose(
        registerSSEStream({ triggerEvents: [messageEvent], auth: headerAuth }),
      );

      const events = await api.createStream({ request: post('hi', 'dave') }, collect);

      expect(replyOf(events).principalId).toBe('dave');
      expect(seenByTool).toEqual([{ id: 'dave', role: 'member' }]);
    });

    test('onRequest sees the principal; emitStartEvent stamps it', async () => {
      const seen: Array<Principal | undefined> = [];
      const store = createInMemoryNetworkStore();
      const { network } = historyNetwork({ store });
      const api = network.expose(
        registerSSEStream({
          triggerEvents: [messageEvent],
          auth: headerAuth,
          onRequest: ({ principal, emitStartEvent, payload }) => {
            seen.push(principal);
            emitStartEvent({
              runId: 'run-1',
              contextId: 'ctx',
              event: messageEvent.make(payload),
            });
          },
        }),
      );

      const events = await api.createStream({ request: post('hello', 'erin') }, collect);

      expect(seen).toEqual([{ id: 'erin', role: 'member' }]);
      expect(replyOf(events)).toEqual({ seen: ['hello'], principalId: 'erin' });
      const [start] = await store.readRun(
        { namespace: 'principal:erin', contextId: 'ctx' },
        'run-1',
      );
      expect(start?.meta.principalId).toBe('erin');
    });

    test('a principal without a string id fails the request', async () => {
      const { network, principals } = historyNetwork();
      const api = network.expose(
        registerSSEStream({
          triggerEvents: [messageEvent],
          auth: () => ({ allowed: true, principal: { id: '' } }),
        }),
      );

      await expect(api.createStream({ request: post('hi') }, collect)).rejects.toThrow(/principal/);
      expect(principals).toEqual([]);
    });
  });

  describe('shared plane', () => {
    /** Runs `body` with a shared plane of `network` and an api exposed on it. */
    function withSharedPlane<T>(
      network: AgentNetwork,
      body: (ctx: {
        plane: import('../agent-network/event-plane.js').EventPlane;
        api: ReturnType<AgentNetwork['expose']>;
      }) => Promise<T>,
    ): Promise<T> {
      return Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* network.run();
          const api = network.expose(
            registerSSEStream({ plane, triggerEvents: [messageEvent], auth: headerAuth }),
          );
          return yield* Effect.promise(() => body({ plane, api }));
        }).pipe(Effect.scoped),
      );
    }

    const storedNamespaces = async (store: AgentNetworkStore, contextId: string) => ({
      anonymous: (await store.readContext({ namespace: 'anonymous', contextId })).events.map(
        (e) => e.name,
      ),
      alice: (await store.readContext({ namespace: 'principal:alice', contextId })).events.map(
        (e) => e.name,
      ),
    });

    test('proxy publish ignores a principalId in the event or meta', async () => {
      const store = createInMemoryNetworkStore();
      const { network } = historyNetwork({ store });

      const { principalIds, namespaces } = await withSharedPlane(network, async ({ api }) => {
        const spoofed = {
          name: 'note',
          meta: { runId: 'r1', contextId: 'ctx', principalId: 'alice' },
          payload: {},
        };
        await api.publish(spoofed);
        await api.publish(
          { name: 'note', payload: {} },
          // A caller passing it anyway, past the types.
          { meta: { runId: 'r2', contextId: 'ctx', principalId: 'alice' } as never },
        );
        await api
          .withMeta({ runId: 'r3', contextId: 'ctx', principalId: 'alice' } as never)
          .publish({ name: 'note', payload: {} });
        const all = (await store.readContext({ namespace: 'anonymous', contextId: 'ctx' })).events;
        return {
          principalIds: all.map((e) => e.meta.principalId),
          namespaces: await storedNamespaces(store, 'ctx'),
        };
      });

      expect(namespaces).toEqual({ anonymous: ['note', 'note', 'note'], alice: [] });
      expect(principalIds).toEqual([undefined, undefined, undefined]);
    });

    test('trusted server code passes the principal explicitly', async () => {
      const store = createInMemoryNetworkStore();
      const { network } = historyNetwork({ store });
      const alice: Principal = { id: 'alice' };

      const namespaces = await withSharedPlane(network, async ({ api }) => {
        await api.publish(
          { name: 'note', payload: {} },
          {
            meta: { runId: 'r1', contextId: 'ctx' },
            principal: alice,
          },
        );
        await api
          .withMeta({ runId: 'r2', contextId: 'ctx' }, { principal: alice })
          .publish({ name: 'note', payload: {} });
        return storedNamespaces(store, 'ctx');
      });

      expect(namespaces).toEqual({ anonymous: [], alice: ['note', 'note'] });
    });

    test("an event for another principal's run is refused, not delivered", async () => {
      const warn = vi.fn();
      const { network, principals } = historyNetwork({ logger: { warn } });

      const result = await withSharedPlane(network, async ({ plane, api }) => {
        const ended = Effect.runPromise(plane.awaitRunEnd('alice-run'));
        // Alice's run, started by trusted code.
        await Effect.runPromise(
          plane.publish(ChannelName('main'), {
            name: 'message',
            meta: { runId: 'alice-run', contextId: 'ctx', principalId: 'alice' },
            payload: { text: 'from alice' },
          }),
        );
        await ended;
        // An anonymous publish into Alice's run.
        const accepted = await api.publish(messageEvent.make({ text: 'injected' }), {
          meta: { runId: 'alice-run', contextId: 'ctx' },
        });
        return { accepted };
      });

      expect(result.accepted).toBe(false);
      expect(principals).toEqual([{ id: 'alice' }]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('the run belongs to another principal'),
        { event: 'message', runId: 'alice-run' },
      );
    });

    test("a request reusing another principal's runId is forbidden", async () => {
      const { network } = historyNetwork();

      const error = await withSharedPlane(network, async ({ plane }) => {
        await Effect.runPromise(
          plane.publish(ChannelName('main'), {
            name: 'message',
            meta: { runId: 'alice-run', contextId: 'ctx', principalId: 'alice' },
            payload: { text: 'from alice' },
          }),
        );
        const api = network.expose(
          registerSSEStream({
            plane,
            triggerEvents: [messageEvent],
            auth: headerAuth,
            onRequest: ({ emitStartEvent, payload, req }) =>
              emitStartEvent({
                runId: req.runId ?? 'x',
                contextId: 'ctx',
                event: messageEvent.make(payload),
              }),
          }),
        );
        return api.createStream({ request: post('hi', 'bob'), runId: 'alice-run' }, collect).then(
          () => undefined,
          (e: unknown) => e,
        );
      });

      expect(error).toBeInstanceOf(ExposeAuthError);
      expect((error as ExposeAuthError).status).toBe(403);
    });

    test("a principal's passive stream never sees another principal's events", async () => {
      const passive = AgentNetwork.setup(({ createChannel, proxy }) => {
        createChannel('client').proxy(proxy.sse());
      });

      const received = await Effect.runPromise(
        Effect.gen(function* () {
          const plane = yield* passive.run();
          const api = passive.expose(registerSSEStream({ plane, auth: headerAuth }));
          const abort = new AbortController();
          const seen: Envelope[] = [];
          const reading = api.createStream(
            {
              request: new Request('http://test/api', {
                headers: { 'x-user': 'bob' },
                signal: abort.signal,
              }),
            },
            async (stream) => {
              for await (const envelope of stream) seen.push(envelope);
            },
          );
          yield* Effect.sleep('20 millis');
          for (const principalId of ['alice', undefined, 'bob']) {
            yield* plane.publish(ChannelName('client'), {
              name: 'note',
              meta: {
                runId: `run-${principalId ?? 'anon'}`,
                contextId: 'ctx',
                ...(principalId && { principalId }),
              },
              payload: { for: principalId ?? 'anonymous' },
            });
          }
          yield* Effect.sleep('20 millis');
          abort.abort();
          yield* Effect.promise(() => reading);
          return seen;
        }).pipe(Effect.scoped),
      );

      expect(received.map((e) => e.payload)).toEqual([{ for: 'bob' }]);
    });
  });

  test('types', () => {
    expectTypeOf<Extract<AuthResult, { allowed: true }>>().toEqualTypeOf<{
      allowed: true;
      principal?: Principal;
    }>();
    expectTypeOf<Principal>().toEqualTypeOf<{
      readonly id: string;
      readonly [claim: string]: unknown;
    }>();
    expectTypeOf<OnRequestContext['principal']>().toEqualTypeOf<Principal | undefined>();
    expectTypeOf<PublishInboundOptions['principal']>().toEqualTypeOf<Principal | undefined>();
    // Proxy meta cannot carry a principal: it is passed explicitly.
    expectTypeOf<NonNullable<PublishInboundOptions['meta']>>().not.toHaveProperty('principalId');
    AgentFactory.run()
      .listensTo([messageEvent])
      .logic(async (ctx) => {
        expectTypeOf(ctx.principal).toEqualTypeOf<Principal | undefined>();
      });
  });
});
