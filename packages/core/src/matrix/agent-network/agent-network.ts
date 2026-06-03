import type { Schema as S } from 'effect';
import { Effect, type Layer, type Scope } from 'effect';
import type { AgentFactory } from '../agent-factory.js';
import { consoleTracerLayer } from '../console-tracer.js';
import {
  assertDepedencyMatch,
  assertLayersProvided,
  assertUniqueLayerNames,
  type DepedencyLayerDef,
  type LayerInstancesFromDeps,
  toLayerArray,
} from '../dependency-layer.js';
import { expose } from '../io/expose.js';
import type { ExposedAPI, ExposeOptions } from '../io/types.js';
import {
  consoleNetworkTracer,
  type NetworkTracer,
  noopNetworkTracer,
} from '../tracing/network-tracer.js';
import type { AgentNetworkEventDef } from './agent-network-event.js';
import { ChannelName, ConfiguredChannel, Sink } from './channel.js';
import type { Envelope, EventPlane } from './event-plane.js';
import { createEventPlane, run } from './event-plane.js';
import type { AgentNetworkStore } from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';

/* ─── Helper Types ─── */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/** Structural interface for any Agent – avoids variance issues with private fields. */
export interface AnyAgent {
  getId(): string;
  // biome-ignore lint/suspicious/noExplicitAny: needed for builder pattern
  invoke(options?: any): Promise<void>;
  /** Event names this agent listens to. Empty = listen to all. */
  getListensTo?(): readonly string[];
  /** Dependency layer definitions declared by this agent */
  getDependencyLayers?(): ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;
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

/* ─── Setup Options ─── */

export type AgentNetworkSetupOptions = {
  /** Log network runs, events, and agent invocations to stdout. Off by default. */
  consoleTracing?: boolean;
  /** Custom NetworkTracer for agent network lifecycle hooks. */
  networkTracer?: NetworkTracer;
  /** Effect layer for event plane span logging. */
  tracingLayer?: Layer.Layer<never>;
};

export type NetworkRunOptions<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
> = [TDeps] extends [never]
  ? { capacity?: number; layers?: Record<string, never> }
  : { capacity?: number; layers: LayerInstancesFromDeps<TDeps> };

function resolveSetupTracing(options?: AgentNetworkSetupOptions): {
  networkTracer: NetworkTracer;
  tracingLayer: Layer.Layer<never> | undefined;
} {
  const consoleTracing = options?.consoleTracing ?? false;
  return {
    networkTracer:
      options?.networkTracer ?? (consoleTracing ? consoleNetworkTracer : noopNetworkTracer),
    tracingLayer: options?.tracingLayer ?? (consoleTracing ? consoleTracerLayer : undefined),
  };
}

/* ─── Setup Context ─── */

export type AgentNetworkSetupContext = {
  mainChannel: ConfiguredChannel;
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

/* ─── AgentNetworkBuilder ─── */

export class AgentNetworkBuilder<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
> {
  private _dependencyLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;

  private constructor(
    dependencyLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>,
  ) {
    this._dependencyLayers = dependencyLayers;
  }

  static empty(): AgentNetworkBuilder<never> {
    return new AgentNetworkBuilder([]);
  }

  static fromLayers<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
    layers: ReadonlyArray<D>,
  ): AgentNetworkBuilder<D> {
    assertUniqueLayerNames(layers);
    return new AgentNetworkBuilder(layers);
  }

  dependsOn<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): AgentNetworkBuilder<TDeps | D> {
    const normalized = toLayerArray(layers);
    const allLayers = [...this._dependencyLayers, ...normalized];
    assertUniqueLayerNames(allLayers);
    return new AgentNetworkBuilder<TDeps | D>(allLayers);
  }

  setup(
    callback: (ctx: AgentNetworkSetupContext) => void,
    options?: AgentNetworkSetupOptions,
  ): AgentNetwork<TDeps> {
    const network = new AgentNetwork<TDeps>(options, this._dependencyLayers);
    const ctx = network.createSetupContext();

    callback(ctx);

    return network;
  }
}

/* ─── AgentNetwork ─── */

export class AgentNetwork<TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never> {
  private _mainChannel: ConfiguredChannel | undefined;
  private channels: Map<ChannelName, ConfiguredChannel> = new Map();
  private agentRegistrations: Map<string, AgentRegistration> = new Map();
  private spawnerRegistrations: SpawnerRegistration[] = [];
  private _store: AgentNetworkStore<Envelope>;
  private _networkTracer: NetworkTracer;
  private _tracingLayer: Layer.Layer<never> | undefined;
  private _dependencyLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>>;

  constructor(
    options?: AgentNetworkSetupOptions,
    dependencyLayers: ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>> = [],
  ) {
    this._store = createInMemoryNetworkStore<Envelope>();
    const tracing = resolveSetupTracing(options);
    this._networkTracer = tracing.networkTracer;
    this._tracingLayer = tracing.tracingLayer;
    this._dependencyLayers = dependencyLayers;
  }

  /* ─── Public Static Factory ─── */

  static dependsOn<D extends DepedencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): AgentNetworkBuilder<D> {
    return AgentNetworkBuilder.fromLayers(toLayerArray(layers));
  }

  static setup(
    callback: (ctx: AgentNetworkSetupContext) => void,
    options?: AgentNetworkSetupOptions,
  ): AgentNetwork<never> {
    return AgentNetworkBuilder.empty().setup(callback, options);
  }

  /* ─── Internal Builders ─── */

  /** @internal Creates the typed setup context used by AgentNetworkBuilder. */
  createSetupContext(): AgentNetworkSetupContext {
    const mainChannel = this.addChannel('main');

    return {
      mainChannel,
      createChannel: (name: string) => this.addChannel(name),
      sink: Sink,
      registerAgent: (agent) => this.registerAgentInternal(agent),
      registerAggregator: (aggregator) => this.registerAggregatorInternal(aggregator),
      spawner: (factory) => this.createSpawnerInternal(factory),
    };
  }

  private addChannel(name: string): ConfiguredChannel {
    const channelName = ChannelName(name);
    const existing = this.channels.get(channelName);
    if (existing) {
      return existing;
    }
    const channel = new ConfiguredChannel(channelName);
    this.channels.set(channelName, channel);
    if (channelName === 'main' && !this._mainChannel) {
      this._mainChannel = channel;
    }
    return channel;
  }

  private registerAgentInternal(agent: AnyAgent): AgentBinding {
    assertDepedencyMatch({
      agentId: agent.getId(),
      agentLayers: agent.getDependencyLayers?.() ?? [],
      networkLayers: this._dependencyLayers,
    });

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
        // biome-ignore lint/suspicious/noExplicitAny: needed for builder pattern
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

  getDependencyLayers(): ReadonlyArray<DepedencyLayerDef<string, unknown, S.Schema.Any>> {
    return this._dependencyLayers;
  }

  /** Store defined at network setup time. Shared across all event planes created for this network. */
  getStore(): AgentNetworkStore<Envelope> {
    return this._store;
  }

  /** NetworkTracer configured at setup time. Used by run() and expose() unless overridden. */
  getNetworkTracer(): NetworkTracer {
    return this._networkTracer;
  }

  /** Effect tracing layer configured at setup time. Used by run() and expose() unless overridden. */
  getTracingLayer(): Layer.Layer<never> | undefined {
    return this._tracingLayer;
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
  expose(options: ExposeOptions<TDeps>): ExposedAPI {
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
  run(options?: NetworkRunOptions<TDeps>): Effect.Effect<EventPlane, never, Scope.Scope> {
    assertLayersProvided(this._dependencyLayers, options?.layers as Record<string, unknown>);
    return this.runScoped(this, options);
  }

  private runScoped(
    network: AgentNetwork<TDeps>,
    options?: NetworkRunOptions<TDeps>,
  ): Effect.Effect<EventPlane, never, Scope.Scope> {
    const networkTracer = network.getNetworkTracer();
    const program = Effect.gen(function* () {
      const plane = yield* createEventPlane({
        network,
        capacity: options?.capacity,
        store: network.getStore(),
        networkTracer,
      });
      yield* Effect.fork(
        run(network, plane, {
          networkTracer,
          layers: options?.layers as unknown as Record<string, unknown> | undefined,
        }),
      );
      return plane;
    });
    const tracingLayer = network.getTracingLayer();
    return tracingLayer ? program.pipe(Effect.provide(tracingLayer)) : program;
  }
}
