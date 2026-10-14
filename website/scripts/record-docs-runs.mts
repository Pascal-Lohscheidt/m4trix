/**
 * Records a run of every recordable docs snippet with the real @m4trix/core runtime and writes it
 * to `content/runs/<snippet path without .ts>.json` (a `DocsRun`, see
 * `src/lib/docs/runs/types.ts`). The run player, the network diagram and the walkthrough read
 * those files. Contract: `ops-docs/docs-pilot-spec.md` ("Recordings").
 *
 *   pnpm --filter website docs:record          # (re)write the recordings
 *   pnpm --filter website docs:record:check    # exit 1 when a recording is out of date
 *
 * A snippet is recordable when it exports `network` (an `AgentNetwork`) and `scenario`
 * (`{ start: <unbound event> }`). The recorder publishes `scenario.start` on the main channel and
 * records until the run ends. Agents are named by their export names.
 *
 * Module loading. tsx runs this file with `content/snippets/tsconfig.json`, whose `paths` map
 * `@m4trix/core/matrix` to core's source. tsx honours the mapping, but the website package is
 * CommonJS (no `"type": "module"`), so a snippet loaded with `import()` is compiled to CJS and
 * `require`s core and `effect` (its CJS build), while an `import` from this ES module would load a
 * second, ESM copy of both: two `AgentNetwork` classes and two Effect runtimes. So snippets, core
 * and `effect` are all loaded with `require` below, from one module graph, and checked to be the
 * same instances before anything runs.
 *
 * Attaching the tracer. The snippets call `AgentNetwork.setup(cb)` without options, `network.run()`
 * takes no tracer, and the recorder must not change their code. While the snippets load, the
 * recorder wraps `AgentNetworkBuilder.prototype.setup` (which `AgentNetwork.setup` and
 * `AgentNetwork.dependsOn(...).setup` both go through) to add its own `networkTracer` and `logger`
 * setup options, exactly as if the snippet had passed them, then restores it. To tell which agent
 * published an event (the tracer only sees the envelope), it wraps the `emit` / `emitAndAwait`
 * the runtime hands each registered agent's `invoke`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as EffectModule from '../../packages/core/node_modules/effect/dist/dts/index.js';
import type * as CoreModule from '../../packages/core/src/matrix/index.js';
import type {
  AgentNetwork,
  AnyAgent,
  Envelope,
  NetworkLogger,
  NetworkTracer,
} from '../../packages/core/src/matrix/index.js';
import type { DocsRun, DocsRunEvent, DocsRunTopology } from '../src/lib/docs/runs/types.js';

const WEBSITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNIPPETS = join(WEBSITE, 'content/snippets');
const RUNS = join(WEBSITE, 'content/runs');
const BIOME = join(WEBSITE, '../node_modules/.bin/biome');
const CHECK = process.argv.includes('--check');
const RUN_TIMEOUT = '10 seconds';
const RUN_COMPLETED = 'm4trix:run.completed';
const RESERVED_PREFIX = 'm4trix:';

/* ─── One module graph ───────────────────────────────────────────────── */

const require = createRequire(import.meta.url);
let coreFile: string;
try {
  coreFile = require.resolve('@m4trix/core/matrix');
} catch {
  throw new Error(
    'Cannot resolve @m4trix/core/matrix. Run the recorder with the snippets tsconfig: pnpm --filter website docs:record',
  );
}
const core = require(coreFile) as typeof CoreModule;
// The `effect` core's source requires, so `Effect.runPromise` runs core's effects.
const effectFile = createRequire(coreFile).resolve('effect');
if (!require.cache[effectFile]) {
  throw new Error(
    `Core did not load effect from ${effectFile}; the recorder would run a second copy.`,
  );
}
const { Effect, Queue } = require(effectFile) as typeof EffectModule;

/* ─── Recording hooks ────────────────────────────────────────────────── */

type RawEvent = {
  eventId: string;
  name: string;
  channels: string[];
  /** Agent id; `null` for the scenario and the runtime. */
  by: string | null;
  causationId: string | undefined;
  correlationId: string | undefined;
  /** Published with `emitAndAwait`: its publisher waits for a reply with its correlation id. */
  awaits: boolean;
  payload: unknown;
  /** Agent id and the channel it was delivered on, in invocation order. */
  deliveries: Array<{ agentId: string; channel: string | undefined }>;
};

type PendingEmit = {
  agentId: string;
  cause: string | undefined;
  name: string;
  payload: unknown;
  awaits: boolean;
};

type Recorder = {
  tracer: NetworkTracer;
  logger: NetworkLogger;
  messages: string[];
  events: RawEvent[];
  pending: PendingEmit[];
  errors: string[];
};

function createRecorder(): Recorder {
  const recorder: Recorder = {
    tracer: undefined as unknown as NetworkTracer,
    logger: undefined as unknown as NetworkLogger,
    messages: [],
    events: [],
    pending: [],
    errors: [],
  };
  const byEventId = new Map<string, RawEvent>();
  const log = (message: string, data?: unknown) => {
    recorder.messages.push(data === undefined ? message : `${message} ${safeJson(data)}`);
  };
  recorder.logger = { warn: log, error: log };
  recorder.tracer = {
    onRunStart: async () => {},
    onRunEnd: async () => {},
    onEventPublish: async ({ channel, name, meta, payload }) => {
      const eventId = meta.eventId ?? '';
      const known = byEventId.get(eventId);
      if (known) {
        known.channels.push(channel);
        return;
      }
      const event: RawEvent = {
        eventId,
        name,
        channels: [channel],
        by: null,
        causationId: meta.causationId,
        correlationId: meta.correlationId,
        awaits: false,
        payload,
        deliveries: [],
      };
      if (!name.startsWith(RESERVED_PREFIX)) {
        const at = recorder.pending.findIndex(
          (p) => p.cause === meta.causationId && p.name === name && p.payload === payload,
        );
        if (at >= 0) {
          event.by = recorder.pending[at]?.agentId ?? null;
          event.awaits = recorder.pending[at]?.awaits ?? false;
          recorder.pending.splice(at, 1);
        } else if (meta.causationId !== undefined) {
          recorder.errors.push(`Could not tell which agent published "${name}".`);
        }
      }
      recorder.events.push(event);
      byEventId.set(eventId, event);
    },
    onAgentInvokeStart: async ({ agentId, channel, trigger }) => {
      byEventId.get(trigger.meta.eventId ?? '')?.deliveries.push({ agentId, channel });
      return core.noopRunTraceScope(trigger.meta);
    },
    onAgentInvokeEnd: async () => {},
    flush: async () => {},
  };
  return recorder;
}

/** Wraps the emits the runtime hands `agent`, so the recorder knows who published what. */
function attributeEmits(agent: AnyAgent, recorder: Recorder): () => void {
  const target = agent as Omit<AnyAgent, 'invoke'> & { invoke?: AnyAgent['invoke'] };
  const own = Object.hasOwn(target, 'invoke');
  const previous = agent.invoke;
  const invoke = previous.bind(agent);
  const agentId = agent.getId();
  target.invoke = (options?: Record<string, unknown>) => {
    if (!options) return invoke(options);
    const trigger = options.triggerEvent as Envelope | undefined;
    const wrap = (fn: unknown, awaits: boolean) =>
      typeof fn === 'function'
        ? (event: { name: string; payload: unknown }, ...rest: unknown[]) => {
            recorder.pending.push({
              agentId,
              cause: trigger?.meta.eventId,
              name: event.name,
              payload: event.payload,
              awaits,
            });
            return fn(event, ...rest);
          }
        : fn;
    return invoke({
      ...options,
      emit: wrap(options.emit, false),
      emitAndAwait: wrap(options.emitAndAwait, true),
    });
  };
  return () => {
    if (own) target.invoke = previous;
    else delete target.invoke;
  };
}

/* ─── Snippets ───────────────────────────────────────────────────────── */

function listSnippets(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return listSnippets(path);
      return entry.endsWith('.ts') && !entry.endsWith('.d.ts') ? [path] : [];
    });
}

const toPosix = (path: string) => path.split(sep).join('/');

type LoadedSnippet = { file: string; rel: string; exports: Record<string, unknown> };

/** Loads every snippet, giving each network it builds a recorder (see the file comment). */
function loadSnippets(): { snippets: LoadedSnippet[]; recorders: Map<unknown, Recorder> } {
  const recorders = new Map<unknown, Recorder>();
  const proto = core.AgentNetworkBuilder.prototype;
  const setup = proto.setup;
  proto.setup = function (this: unknown, callback, options) {
    const recorder = createRecorder();
    const network = setup.call(this as never, callback, {
      ...options,
      networkTracer: recorder.tracer,
      logger: recorder.logger,
    });
    recorders.set(network, recorder);
    return network;
  } as typeof setup;
  try {
    const snippets = listSnippets(SNIPPETS).map((file) => ({
      file,
      rel: toPosix(relative(SNIPPETS, file)),
      exports: require(file) as Record<string, unknown>,
    }));
    return { snippets, recorders };
  } finally {
    proto.setup = setup;
  }
}

/* ─── Source lines ───────────────────────────────────────────────────── */

type SourceIndex = {
  /** Top-level `export const` names in source order. */
  order: string[];
  /** Line span (1-based, inclusive) of each top-level `export const`. */
  spans: Map<string, { from: number; to: number }>;
  /** Export name of each event definition → event name. */
  eventDefs: Map<string, string>;
  lines: string[];
};

function indexSource(source: string): SourceIndex {
  const lines = source.split('\n');
  const starts: Array<{ name: string; line: number }> = [];
  const tops: number[] = [];
  lines.forEach((text, i) => {
    // A new top-level statement: column 0, not the closing of the previous one.
    if (/^[^\s)\]}.]/.test(text)) tops.push(i + 1);
    const match = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/.exec(text);
    if (match?.[1]) starts.push({ name: match[1], line: i + 1 });
  });
  const spans = new Map<string, { from: number; to: number }>();
  const eventDefs = new Map<string, string>();
  for (const { name, line } of starts) {
    const next = tops.find((top) => top > line) ?? lines.length + 1;
    spans.set(name, { from: line, to: next - 1 });
    const text = lines.slice(line - 1, next - 1).join('\n');
    const def = /AgentNetworkEvent\s*\.\s*of\(\s*(['"`])([^'"`]+)\1/.exec(text);
    if (def?.[2]) eventDefs.set(name, def[2]);
  }
  return { order: starts.map((s) => s.name), spans, eventDefs, lines };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1-based line of the first `pattern` match inside the span of export `name`. */
function lineIn(index: SourceIndex, name: string, pattern: RegExp): number | null {
  const span = index.spans.get(name);
  if (!span) return null;
  const text = index.lines.slice(span.from - 1, span.to).join('\n');
  const match = pattern.exec(text);
  if (!match) return null;
  return span.from + text.slice(0, match.index).split('\n').length - 1;
}

/** The line of `emit({ name: '<event>'` (or `emit(<Def>.make(`) in the agent's code. */
function emitLine(index: SourceIndex, agent: string, event: string): number | null {
  const defs = [...index.eventDefs].filter(([, name]) => name === event).map(([def]) => def);
  const literal = `\\{\\s*name\\s*:\\s*(['"\`])${escapeRegExp(event)}\\1`;
  const made = defs.length > 0 ? `|(?:${defs.map(escapeRegExp).join('|')})\\s*\\.\\s*make\\(` : '';
  return lineIn(index, agent, new RegExp(`\\bemit(?:AndAwait)?\\(\\s*(?:${literal}${made})`));
}

/* ─── Recording ──────────────────────────────────────────────────────── */

type Scenario = { start: { name: string; payload: unknown } };

function isScenario(value: unknown): value is Scenario {
  const start = (value as { start?: unknown } | null)?.start as
    | { name?: unknown; payload?: unknown }
    | undefined;
  return typeof start === 'object' && start !== null && typeof start.name === 'string';
}

async function record(snippet: LoadedSnippet, recorder: Recorder): Promise<DocsRun> {
  const network = snippet.exports.network as AgentNetwork;
  const scenario = snippet.exports.scenario;
  if (!isScenario(scenario)) {
    throw new Error('`scenario` must be `{ start: <Event>.make(...) }`.');
  }
  const index = indexSource(readFileSync(snippet.file, 'utf8'));

  // Agents are named by their export names, matched by identity.
  const registrations = [...network.getAgentRegistrations().values()];
  const names = new Map<string, string>();
  for (const name of index.order) {
    const value = snippet.exports[name];
    const reg = registrations.find((r) => r.agent === value);
    if (reg && !names.has(reg.agent.getId())) names.set(reg.agent.getId(), name);
  }
  const unnamed = registrations.filter((r) => !names.has(r.agent.getId()));
  if (unnamed.length > 0) {
    throw new Error(
      `${unnamed.length} registered agent(s) are not exported, so the recording cannot name them.`,
    );
  }
  const nameOf = (agentId: string) => names.get(agentId) ?? agentId;
  const withNames = (text: string) =>
    [...names].reduce((out, [id, name]) => out.split(id).join(name), text);

  // Wiring smells fail the recording (setup logged them to the recorder's logger too).
  const { warnings } = network.validate();
  if (warnings.length > 0) {
    throw new Error(
      `The network's wiring has warnings:\n${warnings.map((w) => `- ${withNames(w.message)}`).join('\n')}`,
    );
  }
  recorder.messages.length = 0;

  const mainChannel = network.getMainChannel();
  if (!mainChannel) throw new Error('The network has no main channel.');
  const topology: DocsRunTopology = {
    mainChannel: mainChannel.name,
    channels: [...network.getChannels().values()].map((channel) => {
      const events = channel.getEvents().map((event) => event.name);
      return {
        name: channel.name,
        events: events.length > 0 ? events : null,
        proxies: channel.getProxies().map((proxy) => proxy.kind),
      };
    }),
    agents: registrations.map((reg) => {
      const listensTo = reg.agent.getListensTo?.() ?? [];
      const emits = reg.agent.getEmits?.();
      return {
        name: nameOf(reg.agent.getId()),
        listensTo: listensTo.length > 0 ? [...listensTo] : null,
        emits: emits ? unique(emits.map((event) => event.name)) : null,
        subscribes: unique(reg.subscribedTo.map((channel) => channel.name)),
        publishesTo: unique(reg.publishesTo.map((channel) => channel.name)),
      };
    }),
    terminalEvents: unique(network.getTerminalEvents().map((terminal) => terminal.name)),
  };

  // The run.
  const restore = registrations.map((reg) => attributeEmits(reg.agent, recorder));
  let ended: string | undefined;
  try {
    const runId = 'docs-run';
    const program = Effect.gen(function* () {
      const plane = yield* network.run();
      const fromMain = yield* plane.subscribe(mainChannel.name);
      const published = yield* plane.publish(mainChannel.name, {
        name: scenario.start.name,
        meta: { runId, contextId: snippet.rel },
        payload: scenario.start.payload,
      });
      if (!published) return 'refused' as const;
      while (true) {
        const envelope = yield* Queue.take(fromMain);
        if (envelope.meta.runId === runId && core.isRunEndEnvelope(envelope)) return envelope.name;
      }
    });
    const outcome = await Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.timeoutTo({
          duration: RUN_TIMEOUT,
          onSuccess: (name): string => name,
          onTimeout: (): string => 'timeout',
        }),
      ),
    );
    if (outcome === 'refused') {
      throw new Error(`The main channel refused the start event "${scenario.start.name}".`);
    }
    if (outcome === 'timeout') throw new Error(`The run did not end within ${RUN_TIMEOUT}.`);
    ended = outcome;
  } finally {
    for (const undo of restore) undo();
  }

  if (recorder.errors.length > 0) throw new Error(recorder.errors.join('\n'));
  if (recorder.messages.length > 0) {
    throw new Error(
      `The network logged:\n${recorder.messages.map((m) => `- ${withNames(m)}`).join('\n')}`,
    );
  }
  if (ended !== RUN_COMPLETED) {
    const end = recorder.events.find((event) => event.name === ended);
    throw new Error(`The run ended with ${ended}: ${withNames(safeJson(end?.payload))}`);
  }

  // Events.
  const indexOf = new Map(recorder.events.map((event, i) => [event.eventId, i]));
  const channelOrder = topology.channels.map((channel) => channel.name);
  const agentIds = [...names.keys()];
  /**
   * Who an event is delivered to, from the topology: the runtime enqueues it for every agent
   * subscribed to one of its channels that listens for it (once per agent), in registration
   * order; runtime `m4trix:*` events go to no agent. Whether an agent gets to *handle* a delivery
   * before a terminal event closes the run is timing, so it is not recorded; observed invocations
   * are only checked against this.
   */
  const recipientsOf = (name: string, eventChannels: readonly string[]): string[] =>
    name.startsWith('m4trix:')
      ? []
      : topology.agents
          .filter(
            (agent) =>
              agent.subscribes.some((channel) => eventChannels.includes(channel)) &&
              (agent.listensTo === null || agent.listensTo.includes(name)),
          )
          .map((agent) => agent.name);
  /**
   * The agent an event answers: the first event after an `emitAndAwait` request that carries the
   * request's correlation id and comes from another agent is the reply the requester receives.
   */
  const replyTo = new Map<number, string>();
  recorder.events.forEach((request, r) => {
    if (!request.awaits || request.by === null || request.correlationId === undefined) return;
    const reply = recorder.events.findIndex(
      (event, i) =>
        i > r &&
        event.by !== null &&
        event.by !== request.by &&
        event.correlationId === request.correlationId,
    );
    if (reply >= 0) replyTo.set(reply, nameOf(request.by));
  });
  const events: DocsRunEvent[] = recorder.events.map((raw, i) => {
    let cause = raw.causationId !== undefined ? (indexOf.get(raw.causationId) ?? null) : null;
    const payload = renameIds(jsonValue(raw.payload), names, agentIds);
    // A terminal event ends the run: the run-end event is its consequence.
    const reason = payload as { reason?: unknown; event?: unknown } | null;
    if (cause === null && core.isRunEndEnvelope(raw) && reason?.reason === 'terminal-event') {
      const terminal = recorder.events.slice(0, i).findLastIndex((e) => e.name === reason.event);
      cause = terminal >= 0 ? terminal : null;
    }
    const by = raw.by === null ? null : nameOf(raw.by);
    let line: number | null = null;
    if (by !== null) line = emitLine(index, by, raw.name);
    else if (i === 0)
      line = lineIn(index, 'scenario', /\bstart\s*:/) ?? index.spans.get('scenario')?.from ?? null;
    return {
      i,
      name: raw.name,
      channels: [...raw.channels].sort((a, b) => channelOrder.indexOf(a) - channelOrder.indexOf(b)),
      by,
      cause,
      payload,
      deliveredTo: (() => {
        const recipients = recipientsOf(raw.name, raw.channels);
        const stray = raw.deliveries
          .map((d) => nameOf(d.agentId))
          .filter((name) => !recipients.includes(name));
        if (stray.length > 0) {
          throw new Error(
            `"${raw.name}" invoked ${stray.join(', ')}, which the topology does not deliver it to.`,
          );
        }
        return recipients;
      })(),
      line,
      ...(replyTo.has(i) ? { replyTo: replyTo.get(i) } : {}),
    };
  });

  const id = snippet.rel.replace(/\.ts$/, '');
  // The channel each recipient takes the event from: its first subscribed channel, in channel
  // order, that the event is on (an agent on two of them gets it once).
  const deliveredOn = events.map(
    (event) =>
      new Map(
        event.deliveredTo.map((name) => [
          name,
          event.channels.find((channel) =>
            topology.agents.find((agent) => agent.name === name)?.subscribes.includes(channel),
          ),
        ]),
      ),
  );
  return {
    version: 1,
    id,
    snippet: snippet.rel,
    topology,
    events,
    end: { name: ended },
    walkthrough: walkthrough(topology, events, deliveredOn),
  };
}

/* ─── Walkthrough ────────────────────────────────────────────────────── */

const code = (text: string) => `\`${text}\``;

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function listOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/**
 * One sentence per event: who publishes it where, which agents receive it (and why, for
 * catch-alls), what the channel declares, where it leaves the network and whether it ends the run.
 */
function walkthrough(
  topology: DocsRunTopology,
  events: DocsRunEvent[],
  deliveredOn: Array<Map<string, string | undefined>>,
): string[] {
  const agents = new Map(topology.agents.map((agent) => [agent.name, agent]));
  const channels = new Map(topology.channels.map((channel) => [channel.name, channel]));
  const described = new Set<string>();
  const catchAllSeenOn = new Map<string, Set<string>>();
  const pickUp = ['picks it up', 'takes it from there', 'handles it'];
  let pickUps = 0;

  return events.map((event, i) => {
    const on = list(event.channels.map(code));

    if (event.name.startsWith(RESERVED_PREFIX)) {
      const everywhere =
        event.channels.length === topology.channels.length && event.channels.length > 1;
      const where = everywhere ? `on every channel (${on})` : `on ${on}`;
      const catchAlls = topology.agents
        .filter((a) => a.listensTo === null && a.subscribes.some((c) => event.channels.includes(c)))
        .map((a) => code(a.name));
      const ends = event.name.startsWith(`${RESERVED_PREFIX}run.`);
      let sentence = `The runtime ${i > 0 ? 'then ' : ''}publishes ${code(event.name)} ${where}${ends ? ' to close the run' : ''}`;
      if (catchAlls.length > 0) {
        sentence += `; runtime events never invoke agents, so not even ${list(catchAlls)} ${catchAlls.length > 1 ? 'receive' : 'receives'} it`;
      }
      return `${sentence}.`;
    }

    // Who publishes it, and where.
    const previous = events[i - 1];
    let sentence: string;
    if (event.by === null) {
      sentence = `${code(event.name)} is published on ${on} from outside the network`;
    } else if (previous && previous.by === event.by && previous.cause === event.cause) {
      sentence = `${code(event.by)} then emits ${code(event.name)} on ${on}`;
    } else if (
      event.cause !== null &&
      event.cause === i - 1 &&
      previous?.deliveredTo.includes(event.by)
    ) {
      sentence = `${code(event.by)} receives it and emits ${code(event.name)} on ${on}`;
    } else if (event.cause !== null) {
      sentence = `In response to ${code(events[event.cause]?.name ?? '?')}, ${code(event.by)} emits ${code(event.name)} on ${on}`;
    } else {
      sentence = `${code(event.by)} emits ${code(event.name)} on ${on}`;
    }
    const only = event.channels.length === 1 ? channels.get(event.channels[0] ?? '') : undefined;
    if (only?.events && !described.has(only.name)) {
      described.add(only.name);
      sentence +=
        only.events.length === 1
          ? `, a channel that only carries ${code(only.events[0] ?? '')}`
          : `, a channel declared for ${list(only.events.map(code))}`;
    }

    // A reply goes to the agent waiting for it, whoever subscribes.
    const replyClause = event.replyTo
      ? `${code(event.replyTo)}, waiting in ${code('emitAndAwait')}, receives it as its reply (same ${code('meta.correlationId')})`
      : undefined;

    // Who receives it.
    const listeners = event.deliveredTo.filter((name) => agents.get(name)?.listensTo !== null);
    const catchAlls = event.deliveredTo.filter((name) => agents.get(name)?.listensTo === null);
    const clauses: string[] = [];
    if (listeners.length > 0) {
      const verb = listeners.length > 1 ? 'each receive a copy' : pickUp[pickUps++ % pickUp.length];
      let clause = `${list(listeners.map(code))} ${verb}`;
      const parts = catchAlls.map((name) => {
        const channel = deliveredOn[i]?.get(name) ?? event.channels[0] ?? '';
        const seen = catchAllSeenOn.get(name) ?? new Set<string>();
        catchAllSeenOn.set(name, seen);
        const first = seen.size === 0;
        const known = seen.has(channel);
        seen.add(channel);
        if (first) {
          return `${code(name)}, which has no ${code('listensTo')} and so takes every event on ${code(channel)}, gets a copy too`;
        }
        if (!known)
          return `${code(name)} gets a copy too because it also subscribes to ${code(channel)}`;
        return `${code(name)}, as a catch-all, gets a copy too`;
      });
      if (parts.length > 0) clause += `, and ${list(parts)}`;
      clauses.push(clause);
    } else if (catchAlls.length > 0) {
      for (const name of catchAlls) {
        const seen = catchAllSeenOn.get(name) ?? new Set<string>();
        catchAllSeenOn.set(name, seen);
        for (const channel of event.channels) seen.add(channel);
      }
      clauses.push(
        `only ${list(catchAlls.map(code))}, which ${catchAlls.length > 1 ? 'have' : 'has'} no ${code('listensTo')}, ${catchAlls.length > 1 ? 'receive' : 'receives'} it`,
      );
    }

    // Where it leaves the network, and whether it ends the run.
    const proxied = event.channels.flatMap((name) =>
      (channels.get(name)?.proxies ?? []).map((kind) => ({ channel: name, kind })),
    );
    const endsRun = events.some(
      (later) => later.i > i && later.cause === i && later.name === RUN_COMPLETED,
    );
    const subscribers = topology.agents.filter((a) =>
      a.subscribes.some((c) => event.channels.includes(c)),
    );
    // The run ends right after a terminal event is delivered, closing every mailbox; whether a
    // recipient still handles it is timing, so say what can happen rather than what did.
    const ends = endsRun
      ? event.deliveredTo.length > 0
        ? `as a terminal event, ends the run, so ${list(event.deliveredTo.map(code))} may not get to handle it before the run closes`
        : 'as a terminal event, ends the run'
      : undefined;
    const through =
      proxied.length === 1 && event.channels.length === 1
        ? `its ${code(proxied[0]?.kind ?? '')} proxy`
        : list(proxied.map((p) => `${code(p.channel)}'s ${code(p.kind)} proxy`));
    if (replyClause) clauses.push(replyClause);
    if (event.deliveredTo.length === 0 && replyClause) {
      if (ends) clauses.push(`${code(event.name)}, ${ends}`);
    } else if (event.deliveredTo.length === 0) {
      const nobody =
        subscribers.length > 0
          ? `no agent on ${listOr(event.channels.map(code))} listens for it`
          : `no agent subscribes to ${listOr(event.channels.map(code))}`;
      if (proxied.length > 0) {
        clauses.push(
          `${nobody}, so ${code(event.name)} leaves the network through ${through}${ends ? ` and, ${ends}` : ''}`,
        );
      } else {
        clauses.push(nobody);
        if (ends) clauses.push(`${code(event.name)}, ${ends}`);
      }
    } else {
      const subject = event.deliveredTo.length > 0 ? 'it also' : code(event.name);
      if (proxied.length > 0) {
        clauses.push(
          `${subject} ${event.deliveredTo.length > 0 ? 'streams out' : 'leaves the network'} through ${through}${ends ? ` and, ${ends}` : ''}`,
        );
      } else if (ends) {
        clauses.push(`${code(event.name)}, ${ends}`);
      }
    }

    return `${[sentence, ...clauses].join('; ')}.`;
  });
}

/* ─── Helpers ────────────────────────────────────────────────────────── */

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `value` as plain JSON (what the recording stores). */
function jsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Replaces agent ids (random per process) with agent names, e.g. in run-end payloads. */
function renameIds(value: unknown, names: Map<string, string>, ids: string[]): unknown {
  if (typeof value === 'string') {
    return ids.reduce((out, id) => out.split(id).join(names.get(id) ?? id), value);
  }
  if (Array.isArray(value)) return value.map((item) => renameIds(item, names, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renameIds(item, names, ids)]),
    );
  }
  return value;
}

/**
 * `value` as 2-space JSON with a trailing newline, formatted by the repo's Biome config, so
 * `biome check --write` leaves recordings as the recorder writes them (and `--check` agrees).
 */
function formatJson(value: unknown, path: string): string {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  return execFileSync(BIOME, ['format', `--stdin-file-path=${path}`], {
    input: json,
    encoding: 'utf8',
  });
}

function listRuns(dir: string): string[] {
  try {
    return readdirSync(dir)
      .sort()
      .flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return listRuns(path);
        return entry.endsWith('.json') ? [path] : [];
      });
  } catch {
    return [];
  }
}

/* ─── Main ───────────────────────────────────────────────────────────── */

const { snippets, recorders } = loadSnippets();
const failures: string[] = [];
const outdated: string[] = [];
const written = new Set<string>();

for (const snippet of snippets) {
  const { network, scenario } = snippet.exports;
  if (network === undefined && scenario === undefined) continue;
  try {
    if (network === undefined) throw new Error('It exports `scenario` but no `network`.');
    if (scenario === undefined) throw new Error('It exports `network` but no `scenario`.');
    if (!(network instanceof core.AgentNetwork)) {
      throw new Error(
        '`network` is not an AgentNetwork of the core the recorder loaded (a second copy of @m4trix/core?).',
      );
    }
    const recorder = recorders.get(network);
    if (!recorder) throw new Error('`network` was built before the recorder could attach to it.');

    const run = await record(snippet, recorder);
    const out = join(RUNS, `${run.id}.json`);
    const json = formatJson(run, out);
    const shown = toPosix(relative(WEBSITE, out));
    written.add(out);
    let current: string | undefined;
    try {
      current = readFileSync(out, 'utf8');
    } catch {
      current = undefined;
    }
    if (CHECK) {
      if (current !== json)
        outdated.push(`${shown} ${current === undefined ? 'is missing' : 'is out of date'}`);
      else console.log(`ok  ${shown}`);
    } else {
      mkdirSync(dirname(out), { recursive: true });
      if (current !== json) writeFileSync(out, json);
      console.log(
        `${current === json ? 'unchanged' : 'wrote'}  ${shown}  (${run.events.length} events, ${run.end.name})`,
      );
    }
  } catch (error) {
    failures.push(`${snippet.rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const stale of listRuns(RUNS).filter((file) => !written.has(file))) {
  const shown = toPosix(relative(WEBSITE, stale));
  if (CHECK) outdated.push(`${shown} has no recordable snippet`);
  else
    console.warn(`warning  ${shown} has no recordable snippet; delete it if the snippet is gone`);
}

if (failures.length > 0) {
  console.error(
    `\nRecording failed:\n${failures.map((f) => `  ${f.replace(/\n/g, '\n    ')}`).join('\n')}`,
  );
}
if (outdated.length > 0) {
  console.error(
    `\nRecordings differ (run pnpm --filter website docs:record):\n${outdated.map((o) => `  ${o}`).join('\n')}`,
  );
}
process.exit(failures.length > 0 || outdated.length > 0 ? 1 : 0);
