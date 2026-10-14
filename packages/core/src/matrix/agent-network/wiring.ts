import type { AgentNetwork, AnyAgent } from './agent-network.js';
import { type ConfiguredChannel, channelAcceptsEvent } from './channel.js';

/** Contradictions in a network's wiring: `AgentNetwork.setup()` throws on them. */
export type WiringErrorCode = 'emit-not-accepted' | 'listen-not-accepted';

/** Smells in a network's wiring: logged as warnings at setup. */
export type WiringWarningCode =
  | 'unconsumed-event'
  | 'agent-publishes-nowhere'
  | 'agent-not-subscribed'
  | 'agent-unreachable'
  | 'terminal-event-not-emitted'
  | 'fold-event-unpublished';

/** Options of the wiring check (`AgentNetwork.setup(cb, { wiring })`). */
export type NetworkWiringOptions = {
  /**
   * Warning codes to leave out of the check (at setup and in `network.validate()`), e.g.
   * `'unconsumed-event'` when events are read with `plane.subscribe` directly. Errors cannot be
   * ignored.
   */
  readonly ignore?: ReadonlyArray<WiringWarningCode>;
};

/** One finding of the wiring check (`network.validate()`). */
export type WiringIssue<
  TCode extends WiringErrorCode | WiringWarningCode = WiringErrorCode | WiringWarningCode,
> = {
  readonly code: TCode;
  readonly message: string;
  /** The agent concerned, if any. */
  readonly agentId?: string;
  /** The event concerned, if any. */
  readonly event?: string;
  /** The channels concerned, if any. */
  readonly channels?: ReadonlyArray<string>;
};

export type NetworkValidationResult = {
  readonly errors: ReadonlyArray<WiringIssue<WiringErrorCode>>;
  readonly warnings: ReadonlyArray<WiringIssue<WiringWarningCode>>;
};

/** Thrown by `AgentNetwork.setup()` when the wiring check finds contradictions. */
export class NetworkWiringError extends Error {
  readonly _tag = 'NetworkWiringError' as const;
  readonly errors: ReadonlyArray<WiringIssue<WiringErrorCode>>;

  constructor(errors: ReadonlyArray<WiringIssue<WiringErrorCode>>) {
    const count = errors.length === 1 ? '1 problem' : `${errors.length} problems`;
    super(
      `AgentNetwork.setup: the network's wiring has ${count}:\n` +
        errors.map((error) => `- ${error.message}`).join('\n'),
    );
    this.name = 'NetworkWiringError';
    this.errors = errors;
  }
}

type Registration = {
  readonly agent: AnyAgent;
  readonly subscribedTo: readonly ConfiguredChannel[];
  readonly publishesTo: readonly ConfiguredChannel[];
};

const quote = (names: ReadonlyArray<string>): string => names.map((n) => `"${n}"`).join(', ');

/** `agent "<id>" (listens to …; emits …)`: ids are generated, so the events say which one. */
function describeAgent(agent: AnyAgent): string {
  const listens = agent.getListensTo?.() ?? [];
  const emits = agent.getEmits?.().map((e) => e.name);
  const parts = [`listens to ${listens.length > 0 ? quote(listens) : 'every event'}`];
  if (emits) parts.push(`emits ${emits.length > 0 ? quote(emits) : 'nothing'}`);
  return `agent "${agent.getId()}" (${parts.join('; ')})`;
}

/**
 * True when events published to `channel` leave the network: it has a proxy that streams out,
 * or it is the `client` channel `expose()` falls back to streaming.
 */
const isStreamed = (channel: ConfiguredChannel): boolean =>
  channel.name === 'client' || channel.getProxies().some((proxy) => proxy.direction !== 'inbound');

/**
 * True when events may be published to `channel` from outside the network's agents: the main
 * channel (start events) and channels with a proxy that receives.
 */
const isFedFromOutside = (channel: ConfiguredChannel, main: ConfiguredChannel | undefined) =>
  channel === main || channel.getProxies().some((proxy) => proxy.direction !== 'outbound');

/** @internal The wiring check behind `network.validate()`. */
export function validateWiring(network: AgentNetwork): NetworkValidationResult {
  const errors: Array<WiringIssue<WiringErrorCode>> = [];
  const warnings: Array<WiringIssue<WiringWarningCode>> = [];
  const registrations: Registration[] = [...network.getAgentRegistrations().values()];
  const terminalEvents = new Set(network.getTerminalEvents().map((t) => t.name));
  const main = network.getMainChannel();
  const ignored = new Set<WiringWarningCode>(network.getWiringOptions().ignore ?? []);

  const listensOn = (reg: Registration, event: string, channel: ConfiguredChannel): boolean => {
    if (!reg.subscribedTo.includes(channel)) return false;
    const listens = reg.agent.getListensTo?.() ?? [];
    return listens.length === 0 || listens.includes(event);
  };
  /** The channels `reg`'s emits of `event` land on. */
  const landsOn = (reg: Registration, event: string): ConfiguredChannel[] =>
    reg.publishesTo.filter((channel) => channelAcceptsEvent(channel, event));
  /** True when `event` may be published to `channel` (by an agent, or from outside). */
  const reaches = (event: string, channel: ConfiguredChannel): boolean => {
    if (!channelAcceptsEvent(channel, event)) return false;
    if (isFedFromOutside(channel, main)) return true;
    if (channel.getEvents().some((e) => e.name === event)) return true;
    return registrations.some((reg) => {
      if (!reg.publishesTo.includes(channel)) return false;
      const emits = reg.agent.getEmits?.();
      // An agent that does not say what it emits may emit anything.
      return emits === undefined || emits.some((e) => e.name === event);
    });
  };

  // Events some agent or aggregator folds (`.folds([...])`). Folds read the store, which keeps
  // every durable event of the run and context whatever channel it was published to, so a folded
  // event is consumed wherever it lands.
  const folded = new Set(
    registrations.flatMap((reg) =>
      (reg.agent.getFolds?.() ?? []).flatMap(({ fold }) => fold.eventNames),
    ),
  );

  // What agents emit: where it can go, and whether anything picks it up there.
  for (const reg of registrations) {
    const emits = reg.agent.getEmits?.();
    if (!emits || emits.length === 0) continue;
    const agentId = reg.agent.getId();
    if (reg.publishesTo.length === 0) {
      warnings.push({
        code: 'agent-publishes-nowhere',
        message: `${describeAgent(reg.agent)} emits events but publishes to no channel (publishTo), so its emits go nowhere`,
        agentId,
      });
      continue;
    }
    const replies = new Set(reg.agent.getReplyEvents?.() ?? []);
    for (const { name: event, transient } of emits) {
      const channels = reg.publishesTo.map((c) => c.name as string);
      const targets = landsOn(reg, event);
      if (targets.length === 0) {
        errors.push({
          code: 'emit-not-accepted',
          message: `${describeAgent(reg.agent)} emits "${event}", but none of the channels it publishes to (${quote(channels)}) accepts it (channel.events([...]))`,
          agentId,
          event,
          channels,
        });
        continue;
      }
      const consumed =
        replies.has(event) ||
        terminalEvents.has(event) ||
        // Transient events are never stored, so no fold sees them.
        (folded.has(event) && !transient) ||
        targets.some(
          (channel) =>
            isStreamed(channel) || registrations.some((other) => listensOn(other, event, channel)),
        );
      if (!consumed) {
        const landing = targets.map((c) => c.name as string);
        warnings.push({
          code: 'unconsumed-event',
          message: `"${event}" emitted by ${describeAgent(reg.agent)} reaches no listening agent, no fold and no proxy on ${quote(landing)} (declare it with .emits([...], { reply: true }) if it only answers an emitAndAwait)`,
          agentId,
          event,
          channels: landing,
        });
      }
    }
  }

  // What agents listen to: whether it can ever reach them.
  for (const reg of registrations) {
    const agentId = reg.agent.getId();
    if (reg.subscribedTo.length === 0) {
      warnings.push({
        code: 'agent-not-subscribed',
        message: `${describeAgent(reg.agent)} is not subscribed to any channel, so it is never invoked`,
        agentId,
      });
      continue;
    }
    const listens = reg.agent.getListensTo?.() ?? [];
    if (listens.length === 0) continue;
    const channels = reg.subscribedTo.map((c) => c.name as string);
    let blocked = 0;
    for (const event of listens) {
      if (reg.subscribedTo.some((channel) => channelAcceptsEvent(channel, event))) continue;
      blocked++;
      errors.push({
        code: 'listen-not-accepted',
        message: `${describeAgent(reg.agent)} listens to "${event}", but none of the channels it subscribes to (${quote(channels)}) accepts it (channel.events([...]))`,
        agentId,
        event,
        channels,
      });
    }
    if (blocked > 0) continue;
    const reachable = listens.some((event) =>
      reg.subscribedTo.some((channel) => reaches(event, channel)),
    );
    if (!reachable) {
      warnings.push({
        code: 'agent-unreachable',
        message: `${describeAgent(reg.agent)} subscribes to ${quote(channels)}, but no agent publishes the events it listens to there and they are not fed from outside`,
        agentId,
        channels,
      });
    }
  }

  // What agents fold (`.folds([...])`): whether each folded event can ever be published, by an
  // agent or from outside, on any channel (the store keeps events whatever their channel).
  const channels = [...network.getChannels().values()];
  for (const reg of registrations) {
    const reported = new Set<string>();
    for (const { fold } of reg.agent.getFolds?.() ?? []) {
      for (const event of fold.eventNames) {
        if (reported.has(event) || channels.some((channel) => reaches(event, channel))) continue;
        reported.add(event);
        warnings.push({
          code: 'fold-event-unpublished',
          message: `${describeAgent(reg.agent)} folds "${event}" (fold "${fold.name}"), but nothing publishes it: no agent emits it to a channel that accepts it, and no channel that carries it is fed from outside`,
          agentId: reg.agent.getId(),
          event,
        });
      }
    }
  }

  // Agents that do not say what they emit may emit a terminal event.
  const emitted = registrations.every((reg) => reg.agent.getEmits !== undefined)
    ? new Set(registrations.flatMap((reg) => reg.agent.getEmits?.().map((e) => e.name) ?? []))
    : undefined;
  if (emitted) {
    for (const event of terminalEvents) {
      if (emitted.has(event)) continue;
      warnings.push({
        code: 'terminal-event-not-emitted',
        message: `endsOn("${event}"): no agent emits "${event}", so runs only end on it when it is published from outside`,
        event,
      });
    }
  }

  return { errors, warnings: warnings.filter((warning) => !ignored.has(warning.code)) };
}

/** @internal Runs the wiring check at setup: throws on errors, logs warnings. */
export function assertWiring(network: AgentNetwork): void {
  const { errors, warnings } = validateWiring(network);
  if (errors.length > 0) throw new NetworkWiringError(errors);
  const logger = network.getLogger();
  for (const warning of warnings) logger.warn(`[m4trix] ${warning.message}`, warning);
}
