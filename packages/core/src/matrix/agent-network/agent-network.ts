import { Effect, type Scope } from 'effect';
import type { Schema as S } from 'effect';
import type { AgentFactory } from '../agent-factory';
import type { AgentNetworkEventDef } from './agent-network-event';
import { ChannelName, ConfiguredChannel, Sink } from './channel';
import { createEventPlane, run } from './event-plane';
import type { Envelope, EventPlane } from './event-plane';
import { expose } from '../io/expose';
import type { ExposeOptions, ExposedAPI } from '../io/types';
import type { AgentNetworkStore } from './stores/agent-network-store';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store';

/* ─── Helper Types ─── */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/** Structural interface for any Agent – avoids variance issues with private fields. */
export interface AnyAgent {
  getId(): string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(options?: any): Promise<void>;
  /** Event names this agent listens to. Empty = listen to all. */
  getListensTo?(): readonly string[];
}

/* ─── Agent Binding (returned by registerAgent) ─── */

export type AgentBinding = {
  subscribe(channel: ConfiguredChannel): AgentBinding;
  publishTo(channel: ConfiguredChannel): AgentBinding;
};

/* ─── Spawner Builder ─── */

export type SpawnFn = (
  agent: AnyAgent,
  bindings?: { subscribe?: string[]; publishTo?: string[] },
) => void;

export type SpawnCallbackContext<
  TRegistry extends Record<string, AgentFactory> = Record<string, AgentFactory>,
> = {
  kind: keyof TRegistry & string;
  factory: TRegistry[keyof TRegistry & string];
  payload: {
    id: string;
    params: Record<string, unknown>;
    subscribe?: string[];
    publishTo?: string[];
  };
  spawn: SpawnFn;
};

export type SpawnerBuilder<
  TRegistry extends Record<string, AgentFactory> = Record<string, AgentFactory>,
> = {
  listen(channel: ConfiguredChannel, event: EventDef): SpawnerBuilder<TRegistry>;
  registry<R extends Record<string, AgentFactory>>(reg: R): SpawnerBuilder<R>;
  defaultBinding(
    fn: (ctx: { kind: string }) => {
      subscribe: string[];
      publishTo: string[];
    },
  ): SpawnerBuilder<TRegistry>;
  onSpawn(fn: (ctx: SpawnCallbackContext<TRegistry>) => AnyAgent): SpawnerBuilder<TRegistry>;
};

/* ─── Setup Context ─── */

export type SetupContext = {
  mainChannel: (name: string) => ConfiguredChannel;
  createChannel: (name: string) => ConfiguredChannel;
  sink: typeof Sink;
  registerAgent: (agent: AnyAgent) => AgentBinding;
  registerAggregator: (aggregator: AnyAgent) => AgentBinding;
  spawner: (factory: typeof AgentFactory) => SpawnerBuilder;
};

/* ─── Internal Registration Records ─── */

type AgentRegistration = {
  agent: AnyAgent;
  subscribedTo: ConfiguredChannel[];
  publishesTo: ConfiguredChannel[];
};

type SpawnerRegistration = {
  factoryClass: typeof AgentFactory;
  listenChannel?: ConfiguredChannel;
  listenEvent?: EventDef;
  registry: Record<string, AgentFactory>;
  defaultBindingFn?: (ctx: { kind: string }) => {
    subscribe: string[];
    publishTo: string[];
  };
  onSpawnFn?: (ctx: SpawnCallbackContext<Record<string, AgentFactory>>) => AnyAgent;
};

/* ─── AgentNetwork ─── */

export class AgentNetwork {
  private _mainChannel: ConfiguredChannel | undefined;
  private channels: Map<ChannelName, ConfiguredChannel> = new Map();
  private agentRegistrations: Map<string, AgentRegistration> = new Map();
  private spawnerRegistrations: SpawnerRegistration[] = [];
  private _store: AgentNetworkStore<Envelope>;

  private constructor() {
    this._store = createInMemoryNetworkStore<Envelope>();
  }

  /* ─── Public Static Factory ─── */

  static setup(callback: (ctx: SetupContext) => void): AgentNetwork {
    const network = new AgentNetwork();

    const ctx: SetupContext = {
      mainChannel: (name: string) => {
        const channel = network.addChannel(name);
        network.setMainChannel(channel);
        return channel;
      },
      createChannel: (name: string) => network.addChannel(name),
      sink: Sink,
      registerAgent: (agent) => network.registerAgentInternal(agent),
      registerAggregator: (aggregator) => network.registerAggregatorInternal(aggregator),
      spawner: (factory) => network.createSpawnerInternal(factory),
    };

    callback(ctx);

    return network;
  }

  /* ─── Internal Builders ─── */

  private addChannel(name: string): ConfiguredChannel {
    const channelName = ChannelName(name);
    const channel = new ConfiguredChannel(channelName);
    this.channels.set(channelName, channel);
    return channel;
  }

  private setMainChannel(channel: ConfiguredChannel): void {
    this._mainChannel = channel;
  }

  private registerAgentInternal(agent: AnyAgent): AgentBinding {
    const registration: AgentRegistration = {
      agent,
      subscribedTo: [],
      publishesTo: [],
    };
    this.agentRegistrations.set(agent.getId(), registration);

    const binding: AgentBinding = {
      subscribe(channel: ConfiguredChannel) {
        registration.subscribedTo.push(channel);
        return binding;
      },
      publishTo(channel: ConfiguredChannel) {
        registration.publishesTo.push(channel);
        return binding;
      },
    };

    return binding;
  }

  private registerAggregatorInternal(aggregator: AnyAgent): AgentBinding {
    return this.registerAgentInternal(aggregator);
  }

  private createSpawnerInternal(factoryClass: typeof AgentFactory): SpawnerBuilder {
    const reg: SpawnerRegistration = {
      factoryClass,
      registry: {},
    };

    this.spawnerRegistrations.push(reg);

    const builder: SpawnerBuilder = {
      listen(channel: ConfiguredChannel, event: EventDef) {
        reg.listenChannel = channel;
        reg.listenEvent = event;
        return builder;
      },
      registry(registry: Record<string, AgentFactory>) {
        reg.registry = registry;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return builder as SpawnerBuilder<any>;
      },
      defaultBinding(
        fn: (ctx: { kind: string }) => {
          subscribe: string[];
          publishTo: string[];
        },
      ) {
        reg.defaultBindingFn = fn;
        return builder;
      },
      onSpawn(fn: (ctx: SpawnCallbackContext<Record<string, AgentFactory>>) => AnyAgent) {
        reg.onSpawnFn = fn;
        return builder;
      },
    };

    return builder;
  }

  /* ─── Accessors ─── */

  getChannels(): Map<string, ConfiguredChannel> {
    return this.channels;
  }

  getMainChannel(): ConfiguredChannel | undefined {
    return this._mainChannel;
  }

  getAgentRegistrations(): Map<string, AgentRegistration> {
    return this.agentRegistrations;
  }

  getSpawnerRegistrations(): ReadonlyArray<SpawnerRegistration> {
    return this.spawnerRegistrations;
  }

  /** Store defined at network setup time. Shared across all event planes created for this network. */
  getStore(): AgentNetworkStore<Envelope> {
    return this._store;
  }

  /**
   * Expose the network as a streamable API (e.g. SSE). Returns an ExposedAPI
   * that adapters (NextEndpoint, ExpressEndpoint) consume to produce streamed
   * responses.
   *
   * @example
   * const api = network.expose({ protocol: "sse", auth, select });
   * export const GET = NextEndpoint.from(api, { requestToContextId, requestToRunId }).handler();
   */
  expose(options: ExposeOptions): ExposedAPI {
    return expose(this, options);
  }

  /**
   * Starts the event plane: creates one PubSub per channel and runs subscriber
   * loops for each (agent, channel) pair. Agents subscribed to a channel are
   * invoked concurrently when events are published to that channel.
   *
   * Returns the EventPlane for publishing. Use `Effect.scoped` so the run is
   * interrupted when the scope ends.
   */
  run(capacity?: number): Effect.Effect<EventPlane, never, Scope.Scope> {
    return this.runScoped(this, capacity);
  }

  private runScoped(
    network: AgentNetwork,
    capacity?: number,
  ): Effect.Effect<EventPlane, never, Scope.Scope> {
    return Effect.gen(function* () {
      const plane = yield* createEventPlane({
        network,
        capacity,
        store: network.getStore(),
      });
      yield* Effect.fork(run(network, plane));
      return plane;
    });
  }
}
