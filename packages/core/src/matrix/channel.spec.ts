import { describe, expect, test } from 'vitest';
import { Schema as S } from 'effect';
import {
  Channel,
  ChannelName,
  ConfiguredChannel,
  Proxy as ChannelProxy,
} from './agent-network/channel.js';
import { AgentNetworkEvent } from './agent-network/agent-network-event.js';

describe('Channel', () => {
  describe('ChannelName (branded, kebab-case)', () => {
    test('creates valid kebab-case names', () => {
      expect(ChannelName('my-channel')).toBe('my-channel');
      expect(ChannelName('foo-bar-baz')).toBe('foo-bar-baz');
      expect(ChannelName('a')).toBe('a');
      expect(ChannelName('a1-b2')).toBe('a1-b2');
    });

    test('throws for non-kebab-case names', () => {
      expect(() => ChannelName('MyChannel')).toThrow();
      expect(() => ChannelName('my_channel')).toThrow();
      expect(() => ChannelName('my-channel-')).toThrow();
      expect(() => ChannelName('-my-channel')).toThrow();
    });
  });

  describe('Channel.of', () => {
    test('creates channel with branded name', () => {
      const name = ChannelName('my-channel');
      const ch = Channel.of(name);

      expect(ch.name).toBe('my-channel');
    });
  });

  describe('ConfiguredChannel', () => {
    test('stores name as branded ChannelName', () => {
      const ch = new ConfiguredChannel(ChannelName('my-channel'));
      expect(ch.name).toBe('my-channel');
      expect(ch._tag).toBe('ConfiguredChannel');
    });

    test('.events() attaches event definitions', () => {
      const evt = AgentNetworkEvent.of('some-event', S.Struct({ value: S.Number }));

      const ch = new ConfiguredChannel(ChannelName('main')).events([evt]);

      expect(ch.getEvents()).toHaveLength(1);
      expect(ch.getEvents()[0]?.name).toBe('some-event');
    });

    test('.proxy() attaches a proxy definition', () => {
      const ch = new ConfiguredChannel(ChannelName('main')).proxy(
        ChannelProxy.kafka({ topic: 'my-topic' }),
      );

      expect(ch.getProxies()).toEqual([
        {
          _tag: 'ProxyDef',
          kind: 'kafka',
          config: { topic: 'my-topic' },
          direction: 'outbound',
        },
      ]);
    });

    test('.proxy() sets multiple proxies', () => {
      const ch = new ConfiguredChannel(ChannelName('main')).proxy(
        ChannelProxy.sse(),
        ChannelProxy.kafka({ topic: 'events' }),
      );

      expect(ch.getProxies()).toHaveLength(2);
      expect(ch.getProxies()[0]?.kind).toBe('sse');
      expect(ch.getProxies()[1]?.kind).toBe('kafka');
    });

    test('builder methods are chainable', () => {
      const evt = AgentNetworkEvent.of('evt', S.String);

      const ch = new ConfiguredChannel(ChannelName('main')).events([evt]).proxy(ChannelProxy.sse());

      expect(ch.getEvents()).toHaveLength(1);
      expect(ch.getProxies()[0]?.kind).toBe('sse');
    });

    test('defaults to no events and no proxies', () => {
      const ch = new ConfiguredChannel(ChannelName('empty'));

      expect(ch.getEvents()).toHaveLength(0);
      expect(ch.getProxies()).toHaveLength(0);
    });
  });

  describe('Proxy', () => {
    test('Proxy.kafka creates a kafka proxy definition', () => {
      const s = ChannelProxy.kafka({ topic: 'orders' });

      expect(s).toEqual({
        _tag: 'ProxyDef',
        kind: 'kafka',
        config: { topic: 'orders' },
        direction: 'outbound',
      });
    });

    test('Proxy.sse creates an sse proxy definition', () => {
      const s = ChannelProxy.sse();

      expect(s).toEqual({
        _tag: 'ProxyDef',
        kind: 'sse',
        config: {},
        direction: 'outbound',
      });
    });

    test('Proxy.socketIo creates a bidirectional proxy definition', () => {
      const s = ChannelProxy.socketIo({ namespace: '/agent' });

      expect(s).toEqual({
        _tag: 'ProxyDef',
        kind: 'socket-io',
        config: { namespace: '/agent' },
        direction: 'bidirectional',
      });
    });
  });
});
