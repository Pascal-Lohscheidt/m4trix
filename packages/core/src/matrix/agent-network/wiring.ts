import type { Schema as S } from 'effect';
import { type AnyContextFold, foldEventDefinitions } from '../context/context-fold.js';
import type { AgentNetwork, AnyAgent } from './agent-network.js';
import type { AgentNetworkEventDef } from './agent-network-event.js';
import { type ConfiguredChannel, channelAcceptsEvent } from './channel.js';
import { redactedIn, unstorableIn } from './stored-payload.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

/** Contradictions in a network's wiring: `AgentNetwork.setup()` throws on them. */
export type WiringErrorCode =
  | 'emit-not-accepted'
  | 'listen-not-accepted'
  | 'fold-checkpoint-shared'
  | 'durable-event-redacted';

/** Smells in a network's wiring: logged as warnings at setup. */
export type WiringWarningCode =
  | 'unconsumed-event'
  | 'agent-publishes-nowhere'
  | 'agent-not-subscribed'
  | 'agent-unreachable'
  | 'terminal-event-not-emitted'
  | 'fold-event-unpublished'
  | 'fold-name-shared'
  | 'event-schema-mismatch'
  | 'event-not-storable';

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

/** @internal An event definition the network declares, and where (for messages). */
export type DeclaredEventDefinition = { readonly def: EventDef; readonly source: string };

/**
 * @internal Every event definition the network declares, in order: what its channels carry, then
 * for each agent (or aggregator) what it listens to and emits and what its folds handle. The plane
 * encodes an event published from outside with the first definition of its name.
 */
export function declaredEventDefinitions(network: AgentNetwork): DeclaredEventDefinition[] {
  const declared: DeclaredEventDefinition[] = [];
  const add = (defs: ReadonlyArray<EventDef> = [], source: string): void => {
    for (const def of defs) declared.push({ def, source });
  };
  for (const channel of network.getChannels().values()) {
    add(channel.getEvents(), `channel "${channel.name}"`);
  }
  for (const { agent } of network.getAgentRegistrations().values()) {
    const id = agent.getId();
    add(agent.getListensToEvents?.(), `listened to by agent "${id}"`);
    add(agent.getEmits?.(), `emitted by agent "${id}"`);
    for (const fold of agent.getFolds?.() ?? []) {
      add(foldEventDefinitions(fold), `handled by fold "${fold.name}"`);
    }
  }
  return declared;
}

/**
 * A payload schema's structure, to tell different schemas from equal ones made twice; `null`
 * for one JSON cannot describe (e.g. an annotation holding a cycle), which is only equal to
 * itself.
 */
const shapes = new WeakMap<S.Schema.Any, string | null>();
const shapeOf = (schema: S.Schema.Any): string | null => {
  let shape = shapes.get(schema);
  if (shape === undefined) {
    try {
      // Annotations may hold bigints (e.g. the bound of `S.greaterThanBigInt`), which JSON has
      // no form for.
      shape = JSON.stringify(schema.ast, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value}n` : value,
      );
    } catch {
      shape = null;
    }
    shapes.set(schema, shape);
  }
  return shape;
};

/**
 * Checks of the network's event definitions. Payloads are stored and sent encoded with their
 * event's schema: one name with different schemas may not decode with the one a fold uses, and a
 * durable event whose schema encodes to something JSON cannot hold cannot be stored. Warnings, not
 * errors: different definitions may be deliberate (a fold reading a looser view of an event), a
 * custom `S.declare` may describe plain JSON values, and an optional field may never be set. A
 * durable event whose schema holds `S.Redacted` is an error: its encoded form is the secret in
 * clear, in the store and on every stream. Durable, as the plane decides it: an event is
 * transient only where an agent or aggregator declares it transient (`listensTo`, `emits`).
 */
function checkEventDefinitions(network: AgentNetwork): {
  readonly errors: Array<WiringIssue<WiringErrorCode>>;
  readonly warnings: Array<WiringIssue<WiringWarningCode>>;
} {
  const errors: Array<WiringIssue<WiringErrorCode>> = [];
  const warnings: Array<WiringIssue<WiringWarningCode>> = [];
  type Variant = { readonly schema: S.Schema.Any; readonly sources: Set<string> };
  const variants = new Map<string, Map<S.Schema.Any | string, Variant>>();
  /** Events with a schema that cannot be compared with others (see `shapeOf`): no warning. */
  const uncomparable = new Set<string>();
  const transient = new Set(
    [...network.getAgentRegistrations().values()].flatMap(
      ({ agent }) => agent.getTransientEvents?.() ?? [],
    ),
  );
  for (const { def, source } of declaredEventDefinitions(network)) {
    const byShape = variants.get(def.name) ?? new Map<S.Schema.Any | string, Variant>();
    variants.set(def.name, byShape);
    const described = shapeOf(def.payload);
    if (described === null) uncomparable.add(def.name);
    const shape = described ?? def.payload;
    const variant = byShape.get(shape) ?? { schema: def.payload, sources: new Set<string>() };
    byShape.set(shape, variant);
    variant.sources.add(source);
  }
  const sourcesOf = (variant: Variant) => [...variant.sources].join(', ');
  for (const [event, byShape] of variants) {
    if (byShape.size > 1 && !uncomparable.has(event)) {
      const listed = [...byShape.values()].map(
        (variant) => `${String(variant.schema)} (${sourcesOf(variant)})`,
      );
      warnings.push({
        code: 'event-schema-mismatch',
        event,
        message:
          `"${event}" has ${byShape.size} different payload schemas: ${listed.join('; ')}. ` +
          'Events published from outside are encoded with the first, emits with the ' +
          "emitter's own definition and folds decode with their handler's, so a payload stored " +
          'with one may not decode with another (folds skip it and report it): give the event ' +
          'one definition and share it',
      });
    }
    // Transient events are never stored.
    if (transient.has(event)) continue;
    for (const variant of byShape.values()) {
      const redacted = redactedIn(variant.schema);
      if (!redacted) continue;
      errors.push({
        code: 'durable-event-redacted',
        event,
        message:
          `"${event}" is durable, but its schema holds S.Redacted (at ` +
          `${redacted.path === '' ? '(root)' : redacted.path}): durable events are stored and ` +
          'streamed encoded with their schema, which puts the secret in clear. Mark the event ' +
          'transient (AgentNetworkEvent.of(name, schema, { transient: true }) in the listensTo ' +
          'or emits of its agents: never stored, and streamed as "<redacted>"; a transient ' +
          'definition only on a channel or a fold does not count, the plane stores the event), ' +
          `or remove the secret from its payload. Defined by: ${sourcesOf(variant)}`,
      });
      // One error per event.
      break;
    }
    for (const variant of byShape.values()) {
      const unstorable = unstorableIn(variant.schema);
      if (!unstorable) continue;
      const at = unstorable.path === '' ? '(root)' : unstorable.path;
      warnings.push({
        code: 'event-not-storable',
        event,
        message:
          `"${event}" cannot be stored with a value at ${at}: its schema encodes it as ` +
          `${unstorable.what}, which JSON cannot hold (durable events are stored as JSON, ` +
          'encoded with their schema), so publishing one fails. Give it a schema that encodes ' +
          'to JSON (e.g. S.Date instead of S.DateFromSelf), or make the event transient. ' +
          `Defined by: ${sourcesOf(variant)}`,
      });
    }
  }
  return { errors, warnings };
}

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
      (reg.agent.getFolds?.() ?? []).flatMap((fold) => fold.eventNames),
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
    for (const fold of reg.agent.getFolds?.() ?? []) {
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

  // Folds by name, across agents and aggregators. State is cached per fold object, so different
  // folds with one name are folded separately (and the fold-read metric reports them as one): a
  // warning. Different compactable folds of one name and version would also share checkpoints,
  // which are stored by name and version, and restore each other's states: an error. One fold
  // object read by several agents is fine.
  const foldsByName = new Map<string, Map<AnyContextFold, AnyAgent[]>>();
  for (const reg of registrations) {
    for (const fold of reg.agent.getFolds?.() ?? []) {
      const folds = foldsByName.get(fold.name) ?? new Map<AnyContextFold, AnyAgent[]>();
      foldsByName.set(fold.name, folds);
      // Each agent lists a fold once (names are unique per agent) and is registered once.
      const readers = folds.get(fold) ?? [];
      folds.set(fold, readers);
      readers.push(reg.agent);
    }
  }
  const readBy = (agents: AnyAgent[], index: number) =>
    `#${index + 1} read by ${agents.map(describeAgent).join(' and ')}`;
  for (const [name, folds] of foldsByName) {
    if (folds.size < 2) continue;
    const byCheckpoint = new Map<string, AnyAgent[][]>();
    for (const [fold, agents] of folds) {
      if (fold.checkpointEventName === undefined) continue;
      const sharing = byCheckpoint.get(fold.checkpointEventName) ?? [];
      byCheckpoint.set(fold.checkpointEventName, [...sharing, agents]);
    }
    const shared = [...byCheckpoint].filter(([, sharing]) => sharing.length > 1);
    for (const [checkpoint, sharing] of shared) {
      errors.push({
        code: 'fold-checkpoint-shared',
        message: `${sharing.length} different folds named "${name}" would share the checkpoints "${checkpoint}": ${sharing.map(readBy).join(', ')}. Checkpoints are stored by fold name and version, so each would restore states the others wrote: give each fold its own name (or version), or define it once and share that object`,
      });
    }
    if (shared.length > 0) continue;
    warnings.push({
      code: 'fold-name-shared',
      message: `${folds.size} different folds are named "${name}": ${[...folds.values()].map(readBy).join(', ')}. Each one is folded and cached on its own, and the m4trix.fold.read.events metric reports them as one fold: give each fold its own name, or define it once and share that object`,
    });
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

  const definitions = checkEventDefinitions(network);
  errors.push(...definitions.errors);
  warnings.push(...definitions.warnings);

  return { errors, warnings: warnings.filter((warning) => !ignored.has(warning.code)) };
}

/** @internal Runs the wiring check at setup: throws on errors, logs warnings. */
export function assertWiring(network: AgentNetwork): void {
  const { errors, warnings } = validateWiring(network);
  if (errors.length > 0) throw new NetworkWiringError(errors);
  const logger = network.getLogger();
  for (const warning of warnings) logger.warn(`[m4trix] ${warning.message}`, warning);
}
