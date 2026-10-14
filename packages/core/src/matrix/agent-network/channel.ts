import type { Schema as S } from 'effect';
import type { ChannelName } from '../identifiers/channel-name.js';
import type { AgentNetworkEventDef } from './agent-network-event.js';
import { isReservedEventName } from './run-lifecycle.js';

export { ChannelName } from '../identifiers/channel-name.js';

/* ─── Proxy ─── */

export type ProxyDirection = 'outbound' | 'inbound' | 'bidirectional';

export type ProxyDef = {
  readonly _tag: 'ProxyDef';
  readonly kind: string;
  readonly config: unknown;
  readonly direction: ProxyDirection;
};

/**
 * Proxies a channel declares (`channel.proxy(...)`): where its events go beyond the network.
 * `sse()` is built in (see `registerSSEStream`); other kinds are declared with `custom(kind)` or
 * `defineProxyKind(kind)` and exposed with `registerCustomProxy`. Kafka or Socket.IO bridges can
 * be built that way on top of `EventTransport`.
 */
const ChannelProxy = {
  sse(): ProxyDef {
    return { _tag: 'ProxyDef', kind: 'sse', config: {}, direction: 'outbound' };
  },
  custom(kind: string, config: unknown = {}, direction: ProxyDirection = 'outbound'): ProxyDef {
    return { _tag: 'ProxyDef', kind, config, direction };
  },
};

export { ChannelProxy as Proxy };

/* ─── Channel Definitions ─── */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/**
 * A channel configured via the builder pattern inside `AgentNetwork.setup()`.
 * Supports `.events()` and `.proxy()` chaining.
 */
export class ConfiguredChannel {
  readonly _tag = 'ConfiguredChannel' as const;
  readonly name: ChannelName;
  private _events: ReadonlyArray<EventDef> = [];
  private _proxies: ReadonlyArray<ProxyDef> = [];

  constructor(name: ChannelName) {
    this.name = name;
  }

  /**
   * Declares the events this channel carries. Publishing any other event to it is refused: an
   * agent's emit throws `EmitValidationError` (reason `channel`), an external publish resolves
   * `false`. Runtime `m4trix:*` events always pass. Without a declaration a channel carries
   * every event.
   */
  events(events: ReadonlyArray<EventDef>): this {
    this._events = [...events];
    return this;
  }

  proxy(...proxies: ProxyDef[]): this {
    this._proxies = [...this._proxies, ...proxies];
    return this;
  }

  getEvents(): ReadonlyArray<EventDef> {
    return this._events;
  }

  getProxies(): ReadonlyArray<ProxyDef> {
    return this._proxies;
  }
}

/**
 * True when `channel` carries events named `name`: it declares no events, declares this one, or
 * `name` is a runtime `m4trix:*` event.
 */
export function channelAcceptsEvent(channel: ConfiguredChannel, name: string): boolean {
  const declared = channel.getEvents();
  return (
    declared.length === 0 || isReservedEventName(name) || declared.some((e) => e.name === name)
  );
}

export function channelHasProxy(channel: ConfiguredChannel, kind: string): boolean {
  return channel.getProxies().some((proxy) => proxy.kind === kind);
}
