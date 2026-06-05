import { Effect, type Layer, Queue, type Schema as S } from 'effect';
import type { AgentNetwork } from '../agent-network/agent-network.js';
import type { AgentNetworkEventDef, EventMeta } from '../agent-network/agent-network-event.js';
import {
  Proxy as ChannelProxy,
  channelHasProxy,
  type ProxyDirection,
} from '../agent-network/channel.js';
import type { Envelope, EventPlane } from '../agent-network/event-plane.js';
import type { DepedencyLayerDef, LayerInstancesFromDeps } from '../dependency-layer.js';
import { ChannelName, type ChannelName as ChannelNameType } from '../identifiers/channel-name.js';
import type { NetworkTracer } from '../tracing/network-tracer.js';
import type {
  AuthResult,
  ExposedAPI,
  ExposeRequest,
  OnRequestContext,
  UnboundEvent,
} from './types.js';

export type SseProxyConsumerOptions<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
> = {
  channel?: ChannelNameType | string;
  events?: string[];
  auth?: (req: ExposeRequest) => AuthResult | Promise<AuthResult>;
  plane?: EventPlane;
  triggerEvents?: ReadonlyArray<AgentNetworkEventDef<string, S.Schema.Any>>;
  onRequest?: <T = unknown>(ctx: OnRequestContext<T>) => void | Promise<void>;
  tracingLayer?: Layer.Layer<never>;
  networkTracer?: NetworkTracer;
  layers?: [TDeps] extends [never] ? Record<string, never> : LayerInstancesFromDeps<TDeps>;
};

export type SseProxyConsumer<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
> = {
  readonly _tag: 'BuiltinProxyConsumer';
  readonly kind: 'sse';
  readonly options: SseProxyConsumerOptions<TDeps>;
};

export type ProxyExposeContext<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
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
  withMeta: (meta: Partial<EventMeta>) => BoundProxyPublisher;
  publishInbound: (envelope: Envelope, target?: 'main' | ChannelNameType) => Promise<boolean>;
  subscribeOutbound: (
    handler: (envelope: Envelope) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<void>;
};

export type CustomProxyConsumer<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
  TOptions extends { channel?: ChannelNameType | string } = { channel?: ChannelNameType | string },
> = {
  readonly _tag: 'CustomProxyConsumer';
  readonly kind: string;
  readonly options: TOptions;
  expose(ctx: ProxyExposeContext<TDeps, TOptions>): InteractiveProxyHandle;
};

export type ProxyConsumer<TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never> =
  | SseProxyConsumer<TDeps>
  | CustomProxyConsumer<TDeps>;

export type PublishTarget = 'main' | 'channel';

export type PublishInboundOptions = {
  target?: PublishTarget;
  meta?: Partial<EventMeta>;
};

export type InteractiveProxyHandle = ExposedAPI & {
  readonly plane?: EventPlane;
  publish(event: UnboundEvent | Envelope, opts?: PublishInboundOptions): Promise<boolean>;
  withMeta(meta: Partial<EventMeta>): BoundProxyPublisher;
};

export type BoundProxyPublisher = {
  publish(event: UnboundEvent | Envelope, target?: PublishTarget): Promise<boolean>;
};

export function registerSSEStream<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
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
      TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
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
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any> = never,
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
    const envelope = isEnvelope(event) ? event : bindEnvelope(opts?.meta ?? {}, event);
    return Effect.runPromise(ctx.plane.publish(channelName, envelope));
  };

  return {
    publish,
    withMeta: (meta) => ({
      publish: (event, target) => publish(event, { target, meta }),
    }),
  };
}

export function createProxyExposeContext<
  TDeps extends DepedencyLayerDef<string, unknown, S.Schema.Any>,
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
    publishInbound: async (envelope, target = 'main') => {
      if (!plane) {
        throw new Error('proxy.publishInbound requires a shared event plane');
      }
      const channel =
        target === 'main' ? ctx.network.getMainChannel()?.name : ChannelName(target as string);
      if (!channel) {
        throw new Error('proxy.publishInbound target "main" requires a main channel');
      }
      return Effect.runPromise(plane.publish(channel, envelope));
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

function bindEnvelope(meta: Partial<EventMeta>, event: UnboundEvent): Envelope {
  return {
    name: event.name,
    meta: {
      runId: meta.runId ?? crypto.randomUUID(),
      contextId: meta.contextId ?? crypto.randomUUID(),
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      ts: meta.ts,
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
          const envelope = yield* Queue.take(dequeue);
          yield* Effect.promise(() => Promise.resolve(input.handler(envelope)));
        }
      }),
    ),
  );
}
