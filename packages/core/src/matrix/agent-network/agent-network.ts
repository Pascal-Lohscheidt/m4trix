import type { Schema as S } from 'effect';
import { Effect, type Layer, type Scope } from 'effect';
import type { EventEnvelope } from '../agent-factory.js';
import { consoleTracerLayer } from '../console-tracer.js';
import type { FoldSource } from '../context/context-fold.js';
import { type FoldCacheOptions, resolveFoldCacheOptions } from '../context/fold-cache.js';
import {
  assertDependencyMatch,
  assertLayersProvided,
  assertUniqueLayerNames,
  type DependencyLayerDef,
  type LayerInstancesFromDeps,
  toLayerArray,
} from '../dependency-layer.js';
import { expose } from '../io/expose.js';
import type { InteractiveProxyHandle, ProxyConsumer } from '../io/proxy-consumer.js';
import { consoleNetworkLogger, type NetworkLogger, resolveLogger } from '../logger.js';
import { guardMetricHandler, type NetworkMetric, type NetworkMetricHandler } from '../metrics.js';
import {
  consoleNetworkTracer,
  type NetworkTracer,
  noopNetworkTracer,
} from '../tracing/network-tracer.js';
import type { AgentNetworkEventDef } from './agent-network-event.js';
import { ChannelName, Proxy as ChannelProxy, ConfiguredChannel } from './channel.js';
import type { Envelope, EventPlane } from './event-plane.js';
import { createEventPlane, startAgents } from './event-plane.js';
import type { EventTransport } from './event-transport.js';
import {
  type AgentErrorPolicy,
  pickRunLimits,
  type ResolvedRunLimits,
  type RunLimitOptions,
  resolveRunLimits,
} from './run-lifecycle.js';
import type { AgentNetworkStore } from './stores/agent-network-store.js';
import { createInMemoryNetworkStore } from './stores/inmemory-network-store.js';
import {
  assertWiring,
  type NetworkValidationResult,
  type NetworkWiringOptions,
  validateWiring,
} from './wiring.js';

export { consoleNetworkLogger, type NetworkLogger } from '../logger.js';

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
  getDependencyLayers?(): ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>;
  /** Max concurrent invocations across runs. Absent or `Infinity` = uncapped. */
  getConcurrency?(): number;
  /** Names of transient events this agent listens to or emits. */
  getTransientEvents?(): readonly string[];
  /**
   * Events this agent (and its tools) may emit. Used by the network's wiring check
   * (`network.validate()`); agents without it are left out of the emit-related checks.
   */
  getEmits?(): ReadonlyArray<EventDef>;
  /** Definitions of the events this agent listens to. */
  getListensToEvents?(): ReadonlyArray<EventDef>;
  /**
   * Emitted events that only answer an `emitAndAwait` (`.emits([...], { reply: true })`): the
   * wiring check does not report them as unconsumed.
   */
  getReplyEvents?(): readonly string[];
  /** The fold sources the agent reads (`.folds([...])`); the wiring check looks at their events. */
  getFolds?(): ReadonlyArray<FoldSource>;
}

/* ─── Agent Binding (returned by registerAgent) ─── */

export type AgentBinding = {
  subscribe(channel: ConfiguredChannel): AgentBinding;
  publishTo(channel: ConfiguredChannel): AgentBinding;
};

/* ─── Setup Options ─── */

export type AgentNetworkSetupOptions = {
  /** Log network runs, events, and agent invocations to stdout. Off by default. */
  consoleTracing?: boolean;
  /** Custom NetworkTracer for agent network lifecycle hooks. */
  networkTracer?: NetworkTracer;
  /** Effect layer for event plane span logging. */
  tracingLayer?: Layer.Layer<never>;
  /**
   * What happens to a run when one of its agents throws. `'fail'` (default) ends the run with
   * `m4trix:run.failed` and aborts its other agents; `'continue'` publishes `m4trix:agent.error`
   * and keeps the run going.
   */
  onAgentError?: AgentErrorPolicy;
  /**
   * Where the network keeps event history (`ctx.history`). Shared by every plane of the network
   * (`run()`, `expose()`). Defaults to a bounded in-memory store (`createInMemoryNetworkStore`).
   */
  store?: AgentNetworkStore;
  /**
   * Receives what the network reports without failing on it: wiring warnings, refused publishes,
   * store and tracer failures, stream errors (see `NetworkLogger`). Defaults to `console`.
   */
  logger?: NetworkLogger;
  /**
   * Carries channel events and `emitAndAwait` replies between the network's planes (see
   * `EventTransport`). Without it each plane gets its own in-memory transport. One
   * `createInMemoryTransport()` connects all planes of the network in this process; a
   * distributed transport would connect several instances.
   */
  transport?: EventTransport;
  /**
   * Receives the network's metrics: run durations and outcomes, agent invocation latencies,
   * mailbox depths, events per run, store writes and usage (see `NetworkMetric`). A throwing
   * handler never breaks the network.
   */
  onMetric?: (metric: NetworkMetric) => void;
  /** Options of the wiring check run at setup (see `network.validate()`). */
  wiring?: NetworkWiringOptions;
  /**
   * Bounds of the cache of folded state behind `ctx.folds` (one per event plane): default 1000
   * states, each kept 30 minutes after its last read (see `FoldCacheOptions`). Only memory depends
   * on them: a dropped state is rebuilt on its next read. Invalid values throw here.
   */
  foldCache?: FoldCacheOptions;
} & RunLimitOptions;

/** An event that completes the run it is published in (see `endsOn`). */
export type RunTerminalEvent = {
  readonly name: string;
  readonly when?: (envelope: Envelope) => boolean;
};

export type NetworkRunOptions<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
> = ([TDeps] extends [never]
  ? { capacity?: number; layers?: Record<string, never> }
  : { capacity?: number; layers: LayerInstancesFromDeps<TDeps> }) &
  /** Limits for every run on the returned plane; they override the network's. */
  RunLimitOptions;

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
  proxy: typeof ChannelProxy;
  registerAgent: (agent: AnyAgent) => AgentBinding;
  registerAggregator: (aggregator: AnyAgent) => AgentBinding;
  /**
   * Declares a terminal event: when it is published in a run (and `when` accepts it, if given),
   * the run completes with `m4trix:run.completed`, its in-flight agents are aborted and its
   * stream closes. Call it once per terminal event.
   */
  endsOn: <E extends EventDef>(event: E, when?: (envelope: EventEnvelope<E>) => boolean) => void;
};

/* ─── Internal Registration Records ─── */

type AgentRegistration = {
  agent: AnyAgent;
  subscribedTo: ConfiguredChannel[];
  publishesTo: ConfiguredChannel[];
};

/* ─── AgentNetworkBuilder ─── */

export class AgentNetworkBuilder<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
> {
  private _dependencyLayers: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>;

  private constructor(
    dependencyLayers: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>,
  ) {
    this._dependencyLayers = dependencyLayers;
  }

  static empty(): AgentNetworkBuilder<never> {
    return new AgentNetworkBuilder([]);
  }

  static fromLayers<D extends DependencyLayerDef<string, unknown, S.Schema.Any>>(
    layers: ReadonlyArray<D>,
  ): AgentNetworkBuilder<D> {
    assertUniqueLayerNames(layers);
    return new AgentNetworkBuilder(layers);
  }

  dependsOn<D extends DependencyLayerDef<string, unknown, S.Schema.Any>>(
    ...layers: [D, ...D[]] | [ReadonlyArray<D>]
  ): AgentNetworkBuilder<TDeps | D> {
    const normalized = toLayerArray(layers);
    const allLayers = [...this._dependencyLayers, ...normalized];
    assertUniqueLayerNames(allLayers);
    return new AgentNetworkBuilder<TDeps | D>(allLayers);
  }

  /**
   * Builds the network with `callback`, then checks its wiring (see `network.validate()`): throws
   * `NetworkWiringError` listing every contradiction, and logs smells as warnings.
   */
  setup(
    callback: (ctx: AgentNetworkSetupContext) => void,
    options?: AgentNetworkSetupOptions,
  ): AgentNetwork<TDeps> {
    const network = new AgentNetwork<TDeps>(options, this._dependencyLayers);
    const ctx = network.createSetupContext();

    callback(ctx);
    // Registrations only happen in the callback, so the wiring is final here.
    assertWiring(network);

    return network;
  }
}

/* ─── AgentNetwork ─── */

export class AgentNetwork<TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never> {
  private _mainChannel: ConfiguredChannel | undefined;
  private channels: Map<ChannelName, ConfiguredChannel> = new Map();
  private agentRegistrations: Map<string, AgentRegistration> = new Map();
  private _store: AgentNetworkStore;
  private _networkTracer: NetworkTracer;
  private _tracingLayer: Layer.Layer<never> | undefined;
  private _dependencyLayers: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>>;
  private _terminalEvents: RunTerminalEvent[] = [];
  private _agentErrorPolicy: AgentErrorPolicy;
  private _runLimits: ResolvedRunLimits;
  private _logger: Required<NetworkLogger>;
  private _transport: EventTransport | undefined;
  private _metricHandler: NetworkMetricHandler | undefined;
  private _wiring: NetworkWiringOptions;
  private _foldCache: FoldCacheOptions;

  constructor(
    options?: AgentNetworkSetupOptions,
    dependencyLayers: ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>> = [],
  ) {
    this._store = options?.store ?? createInMemoryNetworkStore();
    const tracing = resolveSetupTracing(options);
    this._networkTracer = tracing.networkTracer;
    this._tracingLayer = tracing.tracingLayer;
    this._dependencyLayers = dependencyLayers;
    this._agentErrorPolicy = options?.onAgentError ?? 'fail';
    this._runLimits = resolveRunLimits(pickRunLimits(options, 'AgentNetwork.setup'));
    this._logger = resolveLogger(options?.logger ?? consoleNetworkLogger);
    this._transport = options?.transport;
    this._metricHandler = guardMetricHandler(options?.onMetric, this._logger);
    this._wiring = options?.wiring ?? {};
    this._foldCache = options?.foldCache ?? {};
    // Throws on invalid values now rather than when the first plane starts.
    resolveFoldCacheOptions(this._foldCache);
  }

  /* ─── Public Static Factory ─── */

  static dependsOn<D extends DependencyLayerDef<string, unknown, S.Schema.Any>>(
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
      proxy: ChannelProxy,
      registerAgent: (agent) => this.registerAgentInternal(agent),
      registerAggregator: (aggregator) => this.registerAggregatorInternal(aggregator),
      endsOn: (event, when) => {
        this._terminalEvents.push({
          name: event.name,
          ...(when && { when: when as (envelope: Envelope) => boolean }),
        });
      },
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
    assertDependencyMatch({
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

  getDependencyLayers(): ReadonlyArray<DependencyLayerDef<string, unknown, S.Schema.Any>> {
    return this._dependencyLayers;
  }

  /** Store defined at network setup time. Shared across all event planes created for this network. */
  getStore(): AgentNetworkStore {
    return this._store;
  }

  /** Options of the wiring check configured at setup time (`wiring`). */
  getWiringOptions(): NetworkWiringOptions {
    return this._wiring;
  }

  /** Bounds of each plane's fold cache, as configured at setup (`foldCache`). */
  getFoldCacheOptions(): FoldCacheOptions {
    return this._foldCache;
  }

  /** @internal The `onMetric` handler, guarded; `undefined` without one. */
  getMetricHandler(): NetworkMetricHandler | undefined {
    return this._metricHandler;
  }

  /** Transport configured at setup time (`transport`); `undefined` for per-plane in-memory ones. */
  getTransport(): EventTransport | undefined {
    return this._transport;
  }

  /** NetworkTracer configured at setup time. Used by run() and expose() unless overridden. */
  getNetworkTracer(): NetworkTracer {
    return this._networkTracer;
  }

  /** Terminal events declared with `endsOn` at setup time. */
  getTerminalEvents(): ReadonlyArray<RunTerminalEvent> {
    return this._terminalEvents;
  }

  /** Agent failure policy configured at setup time (`onAgentError`, default `'fail'`). */
  getAgentErrorPolicy(): AgentErrorPolicy {
    return this._agentErrorPolicy;
  }

  /** Per-run limits configured at setup time, defaults filled in (see `RunLimitOptions`). */
  getRunLimits(): ResolvedRunLimits {
    return { ...this._runLimits };
  }

  /**
   * Checks the network's wiring: which agents emit and listen to which events on which channels,
   * against what the channels accept (`channel.events([...])`). `errors` are contradictions
   * (setup throws `NetworkWiringError` on them); `warnings` are smells (logged at setup), minus
   * the codes in `wiring.ignore`.
   */
  validate(): NetworkValidationResult {
    return validateWiring(this);
  }

  /**
   * Logger configured at setup time (`logger`, default `console`), with every level: `error`
   * falls back to `warn`, and a throwing logger is ignored.
   */
  getLogger(): Required<NetworkLogger> {
    return this._logger;
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
   * const api = network.expose(registerSSEStream({ channel: "client", auth }));
   * export const GET = NextEndpoint.from(api, { requestToContextId, requestToRunId }).handler();
   */
  expose(consumer: ProxyConsumer<TDeps>): InteractiveProxyHandle {
    return expose(this, consumer);
  }

  /**
   * Starts the event plane: creates one PubSub per channel and runs subscriber
   * loops for each (agent, channel) pair. Agents subscribed to a channel are
   * invoked concurrently when events are published to that channel.
   *
   * Returns the EventPlane for publishing once every agent is subscribed, so events
   * published right away are not missed. Use `Effect.scoped` so the run is interrupted
   * when the scope ends.
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
        limits: pickRunLimits(options, 'network.run'),
      });
      yield* startAgents(network, plane, {
        networkTracer,
        layers: options?.layers as unknown as Record<string, unknown> | undefined,
      });
      return plane;
    });
    const tracingLayer = network.getTracingLayer();
    return tracingLayer ? program.pipe(Effect.provide(tracingLayer)) : program;
  }
}
