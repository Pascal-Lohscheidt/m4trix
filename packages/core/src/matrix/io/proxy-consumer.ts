import { Effect, type Layer, Queue, type Schema as S } from 'effect';
import type * as Duration from 'effect/Duration';
import type { AgentNetwork } from '../agent-network/agent-network.js';
import {
  type AgentNetworkEventDef,
  type EventMeta,
  isMadeEvent,
} from '../agent-network/agent-network-event.js';
import {
  Proxy as ChannelProxy,
  channelHasProxy,
  type ProxyDirection,
} from '../agent-network/channel.js';
import {
  claimRun,
  type Envelope,
  type EventPlane,
  fromWireEnvelope,
  preparePublish,
  wireEnvelope,
} from '../agent-network/event-plane.js';
import {
  isReservedEventName,
  ReservedEventNameError,
  type RunLimitOptions,
} from '../agent-network/run-lifecycle.js';
import type { DependencyLayerDef, LayerInstancesFromDeps } from '../dependency-layer.js';
import { ChannelName, type ChannelName as ChannelNameType } from '../identifiers/channel-name.js';
import { assertPrincipal, type Principal } from '../principal.js';
import type { NetworkTracer } from '../tracing/network-tracer.js';
import type {
  AuthResult,
  ExposedAPI,
  ExposeRequest,
  OnRequestContext,
  UnboundEvent,
} from './types.js';

/**
 * Options of `registerSSEStream()`. The run limits (`maxDepth`, `maxEvents`, `maxTokens`,
 * `maxCostUsd`) apply to each exposed run and override the network's, also on a shared `plane`.
 */
export type SseProxyConsumerOptions<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
> = {
  channel?: ChannelNameType | string;
  events?: string[];
  auth?: (req: ExposeRequest) => AuthResult | Promise<AuthResult>;
  plane?: EventPlane;
  /**
   * Events that start a run. Without `onRequest`, the request payload is decoded with the trigger
   * event's schema before anything runs (a 400 `ExposeValidationError` otherwise). With one trigger
   * event the body is its payload; with several, the body names it: `{ name, payload }`.
   */
  triggerEvents?: ReadonlyArray<AgentNetworkEventDef<string, S.Schema.Any>>;
  onRequest?: <T = unknown>(ctx: OnRequestContext<T>) => void | Promise<void>;
  tracingLayer?: Layer.Layer<never>;
  networkTracer?: NetworkTracer;
  layers?: [TDeps] extends [never] ? Record<string, never> : LayerInstancesFromDeps<TDeps>;
  /**
   * Fail the run (`m4trix:run.failed`, kind `idle-timeout`) when no event is published for it
   * within this window. Default `'60 seconds'`; `Infinity` disables it.
   */
  idleTimeout?: Duration.DurationInput;
  /**
   * Fail the run (`m4trix:run.failed`, kind `max-duration`) when it is still going after this
   * long. Default `'10 minutes'`; `Infinity` disables it.
   */
  maxDuration?: Duration.DurationInput;
  /**
   * How long a run whose stream dropped (client gone) keeps going for a reconnect to resume it
   * (`Last-Event-ID`). Default `'30 seconds'`. Within the window, a resumed stream continues the
   * run live; when none is read by the end of it, the run is cancelled (`m4trix:run.cancelled`)
   * and its agents abort. `0` cancels the run as soon as its stream closes.
   */
  reconnectWindow?: Duration.DurationInput;
} & RunLimitOptions;

export type SseProxyConsumer<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
> = {
  readonly _tag: 'BuiltinProxyConsumer';
  readonly kind: 'sse';
  readonly options: SseProxyConsumerOptions<TDeps>;
};

export type ProxyExposeContext<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
  TOptions,
> = {
  network: AgentNetwork<TDeps>;
  channels: ChannelNameType[];
  options: TOptions;
  plane?: EventPlane;
  createInteractiveStream: (
    opts: Omit<SseProxyConsumerOptions<TDeps>, 'channel'>,
  ) => InteractiveProxyHandle;
  publish: (event: UnboundEvent | Envelope, opts?: PublishInboundOptions) => Promise<boolean>;
  withMeta: (meta: ProxyEventMeta, options?: ProxyPrincipalOptions) => BoundProxyPublisher;
  /**
   * Publishes `envelope` as it came, except for its principal (see
   * `PublishInboundOptions.principal`) and its payload: wire data, decoded with its event's schema,
   * unless it was made with `Event.makeBound` (a value already), like `publish`'s (see the
   * `publish` of `InteractiveProxyHandle`).
   */
  publishInbound: (
    envelope: Envelope,
    target?: 'main' | ChannelNameType,
    options?: ProxyPrincipalOptions,
  ) => Promise<boolean>;
  subscribeOutbound: (
    handler: (envelope: Envelope) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<void>;
};

export type CustomProxyConsumer<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TOptions extends { channel?: ChannelNameType | string } = { channel?: ChannelNameType | string },
> = {
  readonly _tag: 'CustomProxyConsumer';
  readonly kind: string;
  readonly options: TOptions;
  expose(ctx: ProxyExposeContext<TDeps, TOptions>): InteractiveProxyHandle;
};

export type ProxyConsumer<TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never> =
  | SseProxyConsumer<TDeps>
  | CustomProxyConsumer<TDeps>;

export type PublishTarget = 'main' | 'channel';

/** Meta a proxy publish may set. The principal is not part of it: see `ProxyPrincipalOptions`. */
export type ProxyEventMeta = Partial<Omit<EventMeta, 'principalId'>>;

export type ProxyPrincipalOptions = {
  /**
   * The principal the event is published for, as your own server code authenticated it. It is
   * the only source of a proxy-published event's `principalId`: one found on the event or its
   * meta is dropped, so a client relayed through a proxy cannot claim another principal. Without
   * it the event is anonymous, and an event for a run of another principal is refused.
   */
  principal?: Principal;
};

export type PublishInboundOptions = {
  target?: PublishTarget;
  meta?: ProxyEventMeta;
} & ProxyPrincipalOptions;

export type InteractiveProxyHandle = ExposedAPI & {
  readonly plane?: EventPlane;
  /**
   * Publishes an event from outside. An event made with `Event.make` / `makeBound` (or their
   * Effect variants) holds a value already and is published as it is, like `plane.publish` does.
   * Any other payload is wire data, as `subscribeOutbound` and SSE streams send it: decoded with
   * the schema the network knows for its name, so agents get what an emit would give them (a
   * payload that does not decode but already is a value of the type is taken as it is; one that
   * is neither is published as given). A copy of a made event (`{ ...event }`) is wire data again.
   * Resolves `false` when the event was refused (e.g. its run belongs to another principal);
   * rejects with `ReservedEventNameError` or `NonJsonPayloadError`, publishing nothing.
   */
  publish(event: UnboundEvent | Envelope, opts?: PublishInboundOptions): Promise<boolean>;
  withMeta(meta: ProxyEventMeta, options?: ProxyPrincipalOptions): BoundProxyPublisher;
};

export type BoundProxyPublisher = {
  publish(event: UnboundEvent | Envelope, target?: PublishTarget): Promise<boolean>;
};

export function registerSSEStream<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
>(options: SseProxyConsumerOptions<TDeps> = {}): SseProxyConsumer<TDeps> {
  return { _tag: 'BuiltinProxyConsumer', kind: 'sse', options };
}

export const ProxyConsumer = {
  sse: registerSSEStream,
};

export function defineProxyKind<const K extends string>(
  kind: K,
  defaults?: { direction?: ProxyDirection },
) {
  return {
    onChannel: (config: unknown = {}) =>
      ChannelProxy.custom(kind, config, defaults?.direction ?? 'outbound'),
    register<
      TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
      TOptions extends { channel?: ChannelNameType | string } = {
        channel?: ChannelNameType | string;
      },
    >(
      options: TOptions,
      expose: (ctx: ProxyExposeContext<TDeps, TOptions>) => InteractiveProxyHandle,
    ): CustomProxyConsumer<TDeps, TOptions> {
      return { _tag: 'CustomProxyConsumer', kind, options, expose };
    },
  };
}

export function registerCustomProxy<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any> = never,
  TOptions extends { channel?: ChannelNameType | string } = { channel?: ChannelNameType | string },
>(input: {
  kind: string;
  options: TOptions;
  expose: (ctx: ProxyExposeContext<TDeps, TOptions>) => InteractiveProxyHandle;
}): CustomProxyConsumer<TDeps, TOptions> {
  return { _tag: 'CustomProxyConsumer', ...input };
}

export function resolveChannelsForProxyKind(
  network: AgentNetwork,
  kind: string,
  channel?: ChannelNameType | string,
): ChannelNameType[] {
  const channels = network.getChannels();
  if (channel) {
    const name = ChannelName(channel as string);
    assertChannelHasProxyKind(network, name, kind);
    return [name];
  }

  const matches = [...channels.values()]
    .filter((ch) => channelHasProxy(ch, kind))
    .map((ch) => ch.name);
  if (matches.length === 1) return matches;
  if (matches.length > 1) {
    throw new Error(
      `expose: multiple channels declare Proxy kind "${kind}"; pass { channel } on the consumer`,
    );
  }

  const client = channels.get('client' as ChannelNameType);
  if (client) return [client.name];
  const first = channels.values().next().value;
  return first ? [first.name] : [];
}

function assertChannelHasProxyKind(
  network: AgentNetwork,
  name: ChannelNameType,
  kind: string,
): void {
  const channel = network.getChannels().get(name);
  if (!channel) {
    throw new Error(`expose: channel "${name}" does not exist`);
  }
  if (!channelHasProxy(channel, kind)) {
    throw new Error(`expose: channel "${name}" does not declare Proxy kind "${kind}"`);
  }
}

export function createInboundPublisher(ctx: {
  plane?: EventPlane;
  network: AgentNetwork;
  channels: ChannelNameType[];
}): Pick<InteractiveProxyHandle, 'publish' | 'withMeta'> {
  const publish = async (
    event: UnboundEvent | Envelope,
    opts?: PublishInboundOptions,
  ): Promise<boolean> => {
    if (!ctx.plane) {
      throw new Error('proxy.publish requires a shared event plane');
    }

    const target = opts?.target ?? 'main';
    const channelName = resolvePublishTarget(ctx.network, ctx.channels, target);
    const bound = isEnvelope(event) ? event : bindEnvelope(opts?.meta ?? {}, event);
    return publishAsPrincipal(ctx.plane, channelName, bound, opts?.principal, isMadeEvent(event));
  };

  return {
    publish,
    withMeta: (meta, options) => ({
      publish: (event, target) => publish(event, { target, meta, principal: options?.principal }),
    }),
  };
}

export function createProxyExposeContext<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
  TOptions extends { channel?: ChannelNameType | string },
>(ctx: {
  network: AgentNetwork<TDeps>;
  channels: ChannelNameType[];
  options: TOptions;
  createInteractiveStream: (
    opts: Omit<SseProxyConsumerOptions<TDeps>, 'channel'>,
  ) => InteractiveProxyHandle;
}): ProxyExposeContext<TDeps, TOptions> {
  const plane = (ctx.options as { plane?: EventPlane }).plane;
  const inbound = createInboundPublisher({
    plane,
    network: ctx.network,
    channels: ctx.channels,
  });

  return {
    network: ctx.network,
    channels: ctx.channels,
    options: ctx.options,
    plane,
    createInteractiveStream: ctx.createInteractiveStream,
    publish: inbound.publish,
    withMeta: inbound.withMeta,
    publishInbound: async (envelope, target = 'main', options) => {
      if (!plane) {
        throw new Error('proxy.publishInbound requires a shared event plane');
      }
      const channel =
        target === 'main' ? ctx.network.getMainChannel()?.name : ChannelName(target as string);
      if (!channel) {
        throw new Error('proxy.publishInbound target "main" requires a main channel');
      }
      return publishAsPrincipal(
        plane,
        channel,
        envelope,
        options?.principal,
        isMadeEvent(envelope),
      );
    },
    subscribeOutbound: (handler, signal) =>
      subscribeOutbound({
        plane,
        channels: ctx.channels,
        handler,
        signal,
      }),
  };
}

function resolvePublishTarget(
  network: AgentNetwork,
  channels: ChannelNameType[],
  target: PublishTarget,
): ChannelNameType {
  if (target === 'main') {
    const main = network.getMainChannel()?.name;
    if (!main) throw new Error('proxy.publish target "main" requires a main channel');
    return main;
  }

  const channel = channels[0];
  if (!channel) throw new Error('proxy.publish target "channel" requires a proxy channel');
  return channel;
}

/**
 * Publishes `envelope` for `principal` (anonymously without one): its own `principalId`, if any,
 * is replaced, never trusted. Its payload is wire data, decoded with its event's schema (see
 * `fromWireEnvelope`), as `subscribeOutbound` sends it, unless the event was `made` by its
 * definition (`Event.make`, `makeBound`, ...; see `isMadeEvent`): that payload is a value already,
 * published as it is, like `plane.publish` does. Rejects, before it claims the run and publishing
 * nothing, with `ReservedEventNameError` for a reserved `m4trix:` name, which inbound events
 * never carry (they could forge the runtime's own events), and with `NonJsonPayloadError` for a
 * payload the store cannot keep as JSON.
 */
function publishAsPrincipal(
  plane: EventPlane,
  channel: ChannelNameType,
  envelope: Envelope,
  principal: Principal | undefined,
  made: boolean,
): Promise<boolean> {
  if (isReservedEventName(envelope.name)) {
    return Promise.reject(new ReservedEventNameError(envelope.name));
  }
  if (principal !== undefined) assertPrincipal(principal, 'proxy.publish');
  const { principalId: _untrusted, ...meta } = envelope.meta;
  const owned: Envelope = {
    ...envelope,
    meta: principal === undefined ? meta : { ...meta, principalId: principal.id },
  };
  const published = made ? owned : fromWireEnvelope(plane, owned);
  const unstorable = preparePublish(plane, published);
  if (unstorable) return Promise.reject(unstorable);
  // The full principal reaches the run's agents when this event starts the run.
  if (principal !== undefined && !claimRun(plane, envelope.meta.runId, principal)) {
    return Promise.resolve(false);
  }
  return Effect.runPromise(plane.publish(channel, published));
}

function bindEnvelope(meta: ProxyEventMeta, event: UnboundEvent): Envelope {
  return {
    name: event.name,
    meta: {
      runId: meta.runId ?? crypto.randomUUID(),
      contextId: meta.contextId ?? crypto.randomUUID(),
      eventId: meta.eventId,
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      ts: meta.ts,
      depth: meta.depth,
    },
    payload: event.payload,
  };
}

function isEnvelope(event: UnboundEvent | Envelope): event is Envelope {
  return 'meta' in event && typeof event.meta === 'object' && event.meta != null;
}

async function subscribeOutbound(input: {
  plane?: EventPlane;
  channels: ChannelNameType[];
  handler: (envelope: Envelope) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.plane) {
    throw new Error('proxy.subscribeOutbound requires a shared event plane');
  }
  const plane = input.plane;
  const channel = input.channels[0];
  if (!channel) {
    throw new Error('proxy.subscribeOutbound requires a proxy channel');
  }

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dequeue = yield* plane.subscribe(channel);
        while (!input.signal?.aborted) {
          // Leaving the network: in the wire form, as SSE streams send it.
          const envelope = wireEnvelope(plane, yield* Queue.take(dequeue));
          yield* Effect.promise(() => Promise.resolve(input.handler(envelope)));
        }
      }),
    ),
  );
}
