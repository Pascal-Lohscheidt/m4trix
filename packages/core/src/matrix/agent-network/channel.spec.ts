import { Schema as S } from 'effect';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { AgentNetworkEvent } from './agent-network-event.js';
import { ChannelName, Proxy as ChannelProxy, ConfiguredChannel } from './channel.js';

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
        ChannelProxy.custom('queue', { topic: 'my-topic' }),
      );

      expect(ch.getProxies()).toEqual([
        {
          _tag: 'ProxyDef',
          kind: 'queue',
          config: { topic: 'my-topic' },
          direction: 'outbound',
        },
      ]);
    });

    test('.proxy() sets multiple proxies', () => {
      const ch = new ConfiguredChannel(ChannelName('main')).proxy(
        ChannelProxy.sse(),
        ChannelProxy.custom('queue', { topic: 'events' }),
      );

      expect(ch.getProxies()).toHaveLength(2);
      expect(ch.getProxies()[0]?.kind).toBe('sse');
      expect(ch.getProxies()[1]?.kind).toBe('queue');
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
    test('offers only sse and custom (Kafka / Socket.IO are not built in)', () => {
      expect(Object.keys(ChannelProxy).sort()).toEqual(['custom', 'sse']);
      expectTypeOf(ChannelProxy).not.toHaveProperty('kafka');
      expectTypeOf(ChannelProxy).not.toHaveProperty('socketIo');
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

    test('Proxy.custom creates a proxy definition of any kind and direction', () => {
      expect(ChannelProxy.custom('socket-io', { namespace: '/agent' }, 'bidirectional')).toEqual({
        _tag: 'ProxyDef',
        kind: 'socket-io',
        config: { namespace: '/agent' },
        direction: 'bidirectional',
      });
      expect(ChannelProxy.custom('queue')).toEqual({
        _tag: 'ProxyDef',
        kind: 'queue',
        config: {},
        direction: 'outbound',
      });
    });
  });
});
