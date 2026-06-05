import type { Schema as S } from 'effect';
import type { ChannelName } from '../identifiers/channel-name.js';
import type { AgentNetworkEventDef } from './agent-network-event.js';

export { ChannelName } from '../identifiers/channel-name.js';

/* ─── Proxy ─── */

export type ProxyDirection = 'outbound' | 'inbound' | 'bidirectional';

export type ProxyDef = {
  readonly _tag: 'ProxyDef';
  readonly kind: string;
  readonly config: unknown;
  readonly direction: ProxyDirection;
};

const ChannelProxy = {
  sse(): ProxyDef {
    return { _tag: 'ProxyDef', kind: 'sse', config: {}, direction: 'outbound' };
  },
  kafka(config: { topic: string }): ProxyDef {
    return { _tag: 'ProxyDef', kind: 'kafka', config, direction: 'outbound' };
  },
  socketIo(config: { namespace?: string } = {}): ProxyDef {
    return { _tag: 'ProxyDef', kind: 'socket-io', config, direction: 'bidirectional' };
  },
  custom(kind: string, config: unknown = {}, direction: ProxyDirection = 'outbound'): ProxyDef {
    return { _tag: 'ProxyDef', kind, config, direction };
  },
};

export { ChannelProxy as Proxy };

/* ─── Channel Definitions ─── */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

export type ChannelDef = {
  readonly _tag: 'ChannelDef';
  readonly name: ChannelName;
};

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

export function channelHasProxy(channel: ConfiguredChannel, kind: string): boolean {
  return channel.getProxies().some((proxy) => proxy.kind === kind);
}

export const Channel = {
  of(name: ChannelName): ChannelDef {
    return {
      _tag: 'ChannelDef' as const,
      name,
    };
  },
};
