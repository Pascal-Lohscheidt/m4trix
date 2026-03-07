import { type Schema as S } from 'effect';
import type { AgentNetworkEventDef } from './agent-network-event';
import { ChannelName } from '../identifiers/channel-name';

export { ChannelName } from '../identifiers/channel-name';

/* ─── Sink ─── */

export type SinkDef = {
  readonly _tag: 'SinkDef';
  readonly type: string;
  readonly config: unknown;
};

export const Sink = {
  kafka(config: { topic: string }): SinkDef {
    return { _tag: 'SinkDef', type: 'kafka', config };
  },
  httpStream(): SinkDef {
    return { _tag: 'SinkDef', type: 'http-stream', config: {} };
  },
};

export function isHttpStreamSink(sink: SinkDef): boolean {
  return sink.type === 'http-stream';
}

/* ─── Channel Definitions ─── */

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

export type ChannelDef = {
  readonly _tag: 'ChannelDef';
  readonly name: ChannelName;
};

/**
 * A channel configured via the builder pattern inside `AgentNetwork.setup()`.
 * Supports `.events()`, `.sink()`, and `.sinks()` chaining.
 */
export class ConfiguredChannel {
  readonly _tag = 'ConfiguredChannel' as const;
  readonly name: ChannelName;
  private _events: ReadonlyArray<EventDef> = [];
  private _sinks: ReadonlyArray<SinkDef> = [];

  constructor(name: ChannelName) {
    this.name = name;
  }

  events(events: ReadonlyArray<EventDef>): this {
    this._events = [...events];
    return this;
  }

  sink(sink: SinkDef): this {
    this._sinks = [...this._sinks, sink];
    return this;
  }

  sinks(sinks: ReadonlyArray<SinkDef>): this {
    this._sinks = [...sinks];
    return this;
  }

  getEvents(): ReadonlyArray<EventDef> {
    return this._events;
  }

  getSinks(): ReadonlyArray<SinkDef> {
    return this._sinks;
  }
}

export const Channel = {
  of(name: ChannelName): ChannelDef {
    return {
      _tag: 'ChannelDef' as const,
      name,
    };
  },
};
