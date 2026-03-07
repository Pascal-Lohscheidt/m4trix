import { describe, expect, test } from 'vitest';
import { Schema as S } from 'effect';
import {
  Channel,
  ChannelName,
  ConfiguredChannel,
  Sink,
} from './agent-network/channel';
import { AgentNetworkEvent } from './agent-network/agent-network-event';

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
      const evt = AgentNetworkEvent.of(
        'some-event',
        S.Struct({ value: S.Number }),
      );

      const ch = new ConfiguredChannel(ChannelName('main')).events([evt]);

      expect(ch.getEvents()).toHaveLength(1);
      expect(ch.getEvents()[0]?.name).toBe('some-event');
    });

    test('.sink() attaches a sink definition', () => {
      const ch = new ConfiguredChannel(ChannelName('main')).sink(
        Sink.kafka({ topic: 'my-topic' }),
      );

      expect(ch.getSinks()).toEqual([
        {
          _tag: 'SinkDef',
          type: 'kafka',
          config: { topic: 'my-topic' },
        },
      ]);
    });

    test('.sinks() sets multiple sinks', () => {
      const ch = new ConfiguredChannel(ChannelName('main')).sinks([
        Sink.httpStream(),
        Sink.kafka({ topic: 'events' }),
      ]);

      expect(ch.getSinks()).toHaveLength(2);
      expect(ch.getSinks()[0]?.type).toBe('http-stream');
      expect(ch.getSinks()[1]?.type).toBe('kafka');
    });

    test('builder methods are chainable', () => {
      const evt = AgentNetworkEvent.of('evt', S.String);

      const ch = new ConfiguredChannel(ChannelName('main'))
        .events([evt])
        .sink(Sink.httpStream());

      expect(ch.getEvents()).toHaveLength(1);
      expect(ch.getSinks()[0]?.type).toBe('http-stream');
    });

    test('defaults to no events and no sinks', () => {
      const ch = new ConfiguredChannel(ChannelName('empty'));

      expect(ch.getEvents()).toHaveLength(0);
      expect(ch.getSinks()).toHaveLength(0);
    });
  });

  describe('Sink', () => {
    test('Sink.kafka creates a kafka sink definition', () => {
      const s = Sink.kafka({ topic: 'orders' });

      expect(s).toEqual({
        _tag: 'SinkDef',
        type: 'kafka',
        config: { topic: 'orders' },
      });
    });

    test('Sink.httpStream creates an http-stream sink definition', () => {
      const s = Sink.httpStream();

      expect(s).toEqual({
        _tag: 'SinkDef',
        type: 'http-stream',
        config: {},
      });
    });
  });
});
