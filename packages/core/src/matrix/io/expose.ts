import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
  FiberId,
  Queue,
  Runtime,
  type Schema as S,
} from 'effect';
import * as Duration from 'effect/Duration';
import type { AgentNetwork } from '../agent-network/agent-network.js';
import type { AgentNetworkEventDef, EventMeta } from '../agent-network/agent-network-event.js';
import { type ConfiguredChannel, channelAcceptsEvent } from '../agent-network/channel.js';
import type { Envelope, EventPlane, RunMeta } from '../agent-network/event-plane.js';
import {
  claimRun,
  createEventPlane,
  inspectRun,
  isTransientEvent,
  preparePublish,
  setRunLimits,
  startAgents,
  wireEnvelope,
} from '../agent-network/event-plane.js';
import { storeKeyOf } from '../agent-network/history.js';
import {
  DEFAULT_RECONNECT_WINDOW,
  DEFAULT_RUN_IDLE_TIMEOUT,
  DEFAULT_RUN_MAX_DURATION,
  isReservedEventName,
  isRunEndEnvelope,
  isRunLifecycleEnvelope,
  outcomeError,
  outcomeTraceStatus,
  pickRunLimits,
  runEndEnvelope,
  runUnavailableEnvelope,
} from '../agent-network/run-lifecycle.js';
import type { StoredEvent } from '../agent-network/stores/agent-network-store.js';
import { isFoldCheckpointEvent } from '../context/fold-checkpoint.js';
import { assertLayersProvided, type DependencyLayerDef } from '../dependency-layer.js';
import { assertPrincipal, type Principal } from '../principal.js';
import {
  guardNetworkTracer,
  noopNetworkTracer,
  tracerFailureLogger,
} from '../tracing/network-tracer.js';
import { decodeWirePayload } from '../agent-network/stored-payload.js';
import { decodeOrAccept, toValidationIssues, type ValidationIssue } from '../validation.js';
import {
  createInboundPublisher,
  createProxyExposeContext,
  type InteractiveProxyHandle,
  type ProxyConsumer,
  resolveChannelsForProxyKind,
  type SseProxyConsumerOptions,
} from './proxy-consumer.js';
import type { ExposedStream, ExposeRequest, StreamFactory } from './types.js';

type EventDef = AgentNetworkEventDef<string, S.Schema.Any>;

const MALFORMED_JSON: ValidationIssue = { path: '', message: 'Request body is not valid JSON' };
const MALFORMED_QUERY: ValidationIssue = {
  path: '',
  message: 'The payload query parameter is not valid JSON',
};

const isJsonContentType = (value: unknown): boolean =>
  typeof value === 'string' && value.toLowerCase().includes('json');

/** JSON `text`; empty is `{}`. Malformed JSON is an `ExposeValidationError` with `issue`. */
function parseJson(text: string, issue: ValidationIssue = MALFORMED_JSON): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ExposeValidationError([issue]);
  }
}

/** The `payload` query parameter of `url` (absolute or path-only); `undefined` without one. */
function queryPayloadOf(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url, 'http://localhost').searchParams.get('payload') ?? undefined;
  } catch {
    return undefined;
  }
}

type ExpressLikeRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  originalUrl?: string;
  url?: string;
};

/** The `payload` query parameter of an Express request (`req.query`, else its URL). */
function expressQueryPayload(req: ExpressLikeRequest): string | undefined {
  const value = req.query?.payload;
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return first;
  return queryPayloadOf(req.originalUrl ?? req.url);
}

/**
 * Extract the JSON payload from an ExposeRequest: a POST with a JSON body; a GET's `?payload=`
 * (URL-encoded JSON, for `EventSource`, which can only GET); Express `req.body` (parsed here when
 * a raw or text body parser left JSON as a string or buffer); else `{}`. Throws
 * `ExposeValidationError` for malformed JSON.
 */
async function extractPayload(req: ExposeRequest): Promise<unknown> {
  const webRequest = req.request as Request | undefined;
  if (
    webRequest?.method === 'POST' &&
    isJsonContentType(webRequest.headers?.get?.('content-type'))
  ) {
    return parseJson(await webRequest.text());
  }
  if (webRequest?.method === 'GET') {
    const query = queryPayloadOf(webRequest.url);
    if (query !== undefined) return parseJson(query, MALFORMED_QUERY);
  }
  const expressReq = req.req as ExpressLikeRequest | undefined;
  if (expressReq?.method?.toUpperCase() === 'GET') {
    const query = expressQueryPayload(expressReq);
    if (query !== undefined) return parseJson(query, MALFORMED_QUERY);
  }
  const body = expressReq?.body;
  if (body != null) {
    const unparsed = typeof body === 'string' || body instanceof Uint8Array;
    if (unparsed && isJsonContentType(expressReq?.headers?.['content-type'])) {
      return parseJson(typeof body === 'string' ? body : new TextDecoder().decode(body));
    }
    return body;
  }
  return {};
}

/** `issues` located under `prefix` (e.g. `payload`). */
const underPath = (prefix: string, issues: ReadonlyArray<ValidationIssue>): ValidationIssue[] =>
  issues.map((issue) => ({
    ...issue,
    path:
      prefix === '' || issue.path === ''
        ? prefix || issue.path
        : issue.path.startsWith('[')
          ? `${prefix}${issue.path}`
          : `${prefix}.${issue.path}`,
  }));

/**
 * `payload` (an unbound event's, e.g. `Event.make(...)`'s) checked with `def`'s schema: a value of
 * its type is taken as it is, anything else decoded; `ExposeValidationError` otherwise.
 */
function decodeStartPayload(def: EventDef, payload: unknown): unknown {
  const decoded = decodeOrAccept(def.payload, payload);
  if (Either.isLeft(decoded)) throw new ExposeValidationError(decoded.left);
  return decoded.right;
}

/**
 * A request's payload for the trigger `def`: wire data (JSON a client sent), decoded with the
 * event's schema whatever it looks like (see `decodeWirePayload`); `ExposeValidationError` (issues
 * under `at`) when it is neither its encoded form nor a value of its type.
 */
function decodeRequestPayload(def: EventDef, payload: unknown, at = ''): unknown {
  // Every issue of the request, not only the first one.
  const decoded = decodeWirePayload(def.payload, payload, { errors: 'all' });
  if (Either.isRight(decoded)) return decoded.right;
  throw new ExposeValidationError(underPath(at, toValidationIssues(decoded.left)));
}

/**
 * The start event of a request without `onRequest`, from its payload. With one trigger event the
 * payload is that event's payload; with several it names the event: `{ name, payload }`. Without
 * trigger events it is published unchecked as `request`. `at`: where the event's payload is in
 * the request body, for issues.
 */
function startEventFromPayload(
  triggerEvents: ReadonlyArray<EventDef> | undefined,
  payload: unknown,
): { name: string; payload: unknown; at: string } {
  const [only, ...more] = triggerEvents ?? [];
  if (!only) return { name: 'request', payload, at: '' };
  if (more.length === 0) {
    return { name: only.name, payload: decodeRequestPayload(only, payload), at: '' };
  }
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    name?: unknown;
    payload?: unknown;
  };
  const def = triggerEvents?.find((e) => e.name === body.name);
  if (!def) {
    const names = (triggerEvents ?? []).map((e) => `"${e.name}"`).join(', ');
    throw new ExposeValidationError([{ path: 'name', message: `Expected one of ${names}` }]);
  }
  return {
    name: def.name,
    payload: decodeRequestPayload(def, body.payload, 'payload'),
    at: 'payload',
  };
}

/**
 * Every event definition the network knows by name: `triggerEvents` first, then what agents
 * listen to and emit and what channels declare. Used to check `emitStartEvent` events.
 */
function knownEventDefs(
  network: AgentNetwork,
  triggerEvents: ReadonlyArray<EventDef> | undefined,
): Map<string, EventDef> {
  const defs = new Map<string, EventDef>();
  const add = (list: ReadonlyArray<EventDef> | undefined): void => {
    for (const def of list ?? []) if (!defs.has(def.name)) defs.set(def.name, def);
  };
  add(triggerEvents);
  for (const { agent } of network.getAgentRegistrations().values()) {
    add(agent.getListensToEvents?.());
    add(agent.getEmits?.());
  }
  for (const channel of network.getChannels().values()) add(channel.getEvents());
  return defs;
}

/* ─── SSE ids (resume positions) ─── */

/**
 * The SSE id of a durable event: its position in its run, `<contextId>/<runId>/<eventId>` (each
 * URI-encoded). A reconnect sends it back as `Last-Event-ID`; it identifies the run by itself, so
 * resuming works whatever `requestToRunId` returns. Ids are never trusted beyond that: a resume
 * reads the store in the namespace of the request's own principal.
 */
export function sseEventId(
  meta: Pick<EventMeta, 'contextId' | 'runId' | 'eventId'>,
): string | undefined {
  if (meta.eventId === undefined) return undefined;
  return [meta.contextId, meta.runId, meta.eventId].map(encodeURIComponent).join('/');
}

type ResumePosition = { contextId: string; runId: string; eventId: string };

/** The position an SSE id names; `undefined` for anything `sseEventId` did not produce. */
function parseSseEventId(id: string): ResumePosition | undefined {
  const parts = id.split('/');
  if (parts.length !== 3) return undefined;
  try {
    const [contextId, runId, eventId] = parts.map(decodeURIComponent) as [string, string, string];
    if (!contextId || !runId || !eventId) return undefined;
    return { contextId, runId, eventId };
  } catch {
    return undefined;
  }
}

/**
 * The resume position a reconnect carries: the `Last-Event-ID` header (`EventSource` sends it), or
 * the `lastEventId` query parameter (for polyfills that cannot set headers).
 */
function lastEventIdOf(request: Request | undefined): string | undefined {
  const header = request?.headers?.get?.('last-event-id');
  if (header) return header;
  if (typeof request?.url !== 'string') return undefined;
  try {
    return new URL(request.url, 'http://localhost').searchParams.get('lastEventId') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A stream of one run (with `runId`) or of everything on the channel: first `replay`, then what
 * `take` delivers (skipping events whose id is in `seen`), respecting the AbortSignal. With a
 * `runId` it only yields the run's events and ends after its run-end lifecycle event. Both yield
 * the wire form (see `wireEnvelope`): `replay` comes from the store, `take` maps live events.
 */
function createExposedStream(input: {
  take?: () => Promise<Envelope>;
  signal?: AbortSignal | null;
  eventFilter?: string[];
  runId?: string;
  replay?: readonly Envelope[];
  seen?: ReadonlySet<string>;
  idOf: (envelope: Envelope) => string | undefined;
  startId?: string;
}): ExposedStream {
  const { take, signal, eventFilter, runId, replay = [], seen, idOf, startId } = input;
  const shouldInclude = (e: Envelope): boolean =>
    !eventFilter?.length || eventFilter.includes(e.name);
  const aborted = Symbol('aborted');

  return {
    idOf,
    ...(startId !== undefined && { startId }),
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Envelope> {
      for (const envelope of replay) {
        if (signal?.aborted) return;
        yield envelope;
        if (runId !== undefined && isRunEndEnvelope(envelope)) return;
      }
      if (!take) return;

      const abortPromise = new Promise<typeof aborted>((resolve) => {
        if (signal?.aborted) resolve(aborted);
        signal?.addEventListener('abort', () => resolve(aborted), { once: true });
      });

      while (!signal?.aborted) {
        const takePromise = take();
        const next = await Promise.race([takePromise, abortPromise]);
        if (next === aborted) {
          // The pending take is interrupted when the stream's subscription shuts down.
          takePromise.catch(() => {});
          return;
        }

        if (runId !== undefined && next.meta.runId !== runId) continue;
        if (next.meta.eventId !== undefined && seen?.has(next.meta.eventId)) continue;
        if (runId !== undefined && isRunEndEnvelope(next)) {
          yield next;
          return;
        }
        if (shouldInclude(next)) yield next;
      }
    },
  };
}

/** A run streamed by this handle, while its stream (or a resumed one) may still be read. */
type LiveRun = {
  readonly plane: EventPlane;
  readonly meta: RunMeta;
  readonly principalId: string | undefined;
  /** Streams of the run being read right now (its own and resumed ones). */
  streams: number;
  /** Resolved, and replaced, whenever `streams` changes. */
  changed: Deferred.Deferred<void>;
};

const changeStreams = (live: LiveRun, delta: number): void => {
  live.streams += delta;
  const changed = live.changed;
  live.changed = Deferred.unsafeMake<void>(FiberId.none);
  Deferred.unsafeDone(changed, Exit.void);
};

export function createInteractiveStream<
  TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>,
>(
  network: AgentNetwork<TDeps>,
  channels: readonly ConfiguredChannel['name'][],
  options: SseProxyConsumerOptions<TDeps>,
): InteractiveProxyHandle {
  const {
    auth,
    plane: providedPlane,
    onRequest,
    triggerEvents,
    tracingLayer = network.getTracingLayer(),
    layers,
    idleTimeout = DEFAULT_RUN_IDLE_TIMEOUT,
    maxDuration = DEFAULT_RUN_MAX_DURATION,
    reconnectWindow = DEFAULT_RECONNECT_WINDOW,
  } = options;
  const reconnectMillis = Duration.toMillis(reconnectWindow);
  if (!(reconnectMillis >= 0)) {
    throw new Error(
      `registerSSEStream: reconnectWindow must be a non-negative duration, got ${String(reconnectWindow)}`,
    );
  }
  /** Runs this handle streams, by run id: where a resume finds a run that is still going. */
  const liveRuns = new Map<string, LiveRun>();
  /** Envelopes made up for one stream (never stored): they get no SSE id. */
  const synthetic = new WeakSet<Envelope>();
  const store = network.getStore();
  const idOfOn =
    (plane: EventPlane | undefined) =>
    (envelope: Envelope): string | undefined =>
      synthetic.has(envelope) || (plane !== undefined && isTransientEvent(plane, envelope.name))
        ? undefined
        : sseEventId(envelope.meta);
  const logger = network.getLogger();
  const networkTracer = guardNetworkTracer(
    options.networkTracer ?? network.getNetworkTracer() ?? noopNetworkTracer,
    tracerFailureLogger(logger),
  );
  assertLayersProvided(
    network.getDependencyLayers(),
    layers as Record<string, unknown> | undefined,
  );
  // Checked once, up front: a bad limit is a setup error, not a failed request.
  const runLimits = pickRunLimits(options, 'registerSSEStream');
  const hasRunLimits = Object.keys(runLimits).length > 0;
  const eventFilter = options.events;
  const mainChannel = network.getMainChannel();

  if (channels.length === 0) {
    throw new Error('expose: no channels to subscribe to');
  }
  // Start events go to the main channel (else the first one): it must accept the triggers.
  const startChannel = mainChannel ?? network.getChannels().get(channels[0] as string);
  for (const def of triggerEvents ?? []) {
    if (startChannel && !channelAcceptsEvent(startChannel, def.name)) {
      throw new Error(
        `expose: trigger event "${def.name}" is not accepted by channel "${startChannel.name}" (channel.events([...]))`,
      );
    }
  }
  let eventDefs: Map<string, EventDef> | undefined;
  const eventDefFor = (name: string): EventDef | undefined => {
    eventDefs ??= knownEventDefs(network as AgentNetwork, triggerEvents);
    return eventDefs.get(name);
  };

  const createStream = async (
    req: ExposeRequest,
    principal: Principal | undefined,
    consumer?: (stream: ExposedStream) => Promise<unknown>,
  ): Promise<unknown> => {
    // Validated before anything runs: a refused request starts no run, agent or trace.
    // A reconnect resumes its run: nothing is validated, published or started.
    const position = req.lastEventId || lastEventIdOf(req.request);
    if (position) return resumeStream(position, req, principal, consumer);

    const payload = await extractPayload(req);
    const startEvent =
      onRequest || providedPlane ? undefined : startEventFromPayload(triggerEvents, payload);
    const signal = req.request?.signal;
    // The request's namespace: its events carry it, and it only sees events that do.
    const principalId = principal?.id;
    const withPrincipal = (meta: RunMeta): RunMeta & { principalId?: string } =>
      principalId === undefined ? meta : { ...meta, principalId };

    const runState = {
      runId: req.runId ?? crypto.randomUUID(),
      contextId: req.contextId ?? crypto.randomUUID(),
      error: undefined as Error | undefined,
      // Set once a start event is published: only then does this stream own a run.
      started: false,
      // Set when `emitStartEvent` refused its event: the request never started a run.
      refused: false,
      // SSE id of the start event: the stream's position before its first event.
      startId: undefined as string | undefined,
    };
    // The run this stream owns and the plane it runs on, once known.
    let ownedRun: { meta: RunMeta; plane: EventPlane } | undefined;
    let liveRun: LiveRun | undefined;

    // The traced run starts once its ids are final (`onRequest` and the start event may set
    // them), so agent spans, which nest under the start event's run id, find their root run.
    let tracedRun: { runId: string; contextId: string } | undefined;
    let tracedRunStarted: Promise<void> | undefined;
    const startTracedRun = (): Promise<void> => {
      if (!tracedRunStarted) {
        tracedRun = { runId: runState.runId, contextId: runState.contextId };
        tracedRunStarted = networkTracer.onRunStart(tracedRun);
      }
      return tracedRunStarted;
    };

    const program = Effect.gen(function* () {
      const plane =
        providedPlane ??
        (yield* createEventPlane({
          network,
          store: network.getStore(),
          networkTracer,
        }));
      if (!providedPlane) {
        // Returns once every agent is attached, so the start event cannot be missed.
        yield* startAgents(network, plane, {
          networkTracer,
          layers: layers as Record<string, unknown> | undefined,
        });
      }

      const firstChannel = channels[0];
      if (!firstChannel) {
        throw new Error('expose: no channels to subscribe to');
      }
      const targetChannel = mainChannel?.name ?? firstChannel;

      const setRunId = (id: string): void => {
        runState.runId = id;
      };
      const setContextId = (id: string): void => {
        runState.contextId = id;
      };

      /** Applies this stream's limit overrides to `runId`, before its start event. */
      const limitRun = (runId: string): void => {
        if (hasRunLimits) setRunLimits(plane, runId, runLimits);
      };

      /** Makes the request's principal the owner of `runId`; a run of someone else is off-limits. */
      const claim = (runId: string): void => {
        if (!claimRun(plane, runId, principal)) {
          throw new ExposeAuthError('Forbidden: the run belongs to another principal', 403);
        }
      };

      /**
       * Refuses (a 400, `ExposeValidationError`) a start event whose payload the store cannot
       * keep as JSON, the way `plane.publish` would (`NonJsonPayloadError`), before its run is
       * claimed or traced: the request never started a run. `at`: the payload's place in the
       * request, for the issue.
       */
      const refuseUnstorable = (envelope: Envelope, at: string): void => {
        const unstorable = preparePublish(plane, envelope);
        if (!unstorable) return;
        runState.refused = true;
        throw new ExposeValidationError(
          underPath(at, [
            {
              path: unstorable.path,
              message:
                `${unstorable.found} is not JSON-compatible: events are stored as JSON, ` +
                'encoded with their schema',
            },
          ]),
        );
      };

      const emitStartEvent = (opts: {
        contextId: string;
        runId: string;
        event: { name: string; payload: unknown };
      }): void => {
        // The runtime's own names are never a start event (e.g. a client-chosen name forwarded).
        if (isReservedEventName(opts.event.name)) {
          runState.refused = true;
          throw new ExposeValidationError([
            {
              path: 'name',
              message:
                `${JSON.stringify(opts.event.name)} is reserved: names starting with "m4trix:" ` +
                'belong to events the runtime publishes itself.',
            },
          ]);
        }
        // Events the network knows are checked (and decoded) against their schema.
        const def = eventDefFor(opts.event.name);
        let eventPayload = opts.event.payload;
        if (def) {
          try {
            eventPayload = decodeStartPayload(def, opts.event.payload);
          } catch (error) {
            runState.refused = true;
            throw error;
          }
        }
        const meta: EventMeta = {
          ...withPrincipal({ runId: opts.runId, contextId: opts.contextId }),
          eventId: crypto.randomUUID(),
        };
        const envelope: Envelope = {
          name: opts.event.name,
          meta,
          payload: eventPayload,
        };
        refuseUnstorable(envelope, '');
        claim(opts.runId);
        runState.startId ??= sseEventId(meta);
        if (!tracedRunStarted) {
          runState.runId = opts.runId;
          runState.contextId = opts.contextId;
        }
        runState.started = true;
        limitRun(opts.runId);
        startTracedRun()
          .then(() => Effect.runPromise(plane.publish(targetChannel, envelope)))
          .catch(() => {});
      };

      // Subscribe to first channel before emitting (so we don't miss agent output). Once this
      // stream owns a run, other runs' events are not queued for it, so a slow reader only
      // holds back its own run on a shared plane.
      const dequeue = yield* plane.subscribe(
        firstChannel,
        (envelope) =>
          envelope.meta.principalId === principalId &&
          (!runState.started || envelope.meta.runId === runState.runId),
      );

      const ownRun = (): RunMeta | undefined => {
        if (runState.started && !ownedRun) {
          const meta = { runId: runState.runId, contextId: runState.contextId };
          ownedRun = { meta, plane };
          // Findable by resumes while this request runs.
          liveRun = {
            plane,
            meta,
            principalId,
            streams: 1,
            changed: Deferred.unsafeMake<void>(FiberId.none),
          };
          liveRuns.set(meta.runId, liveRun);
        }
        return ownedRun?.meta;
      };

      /**
       * Waits while the run goes on and some stream of it (a resumed one) is read; returns once
       * the run ended, or once no stream was read for `reconnectWindow`.
       */
      const awaitReconnects = (live: LiveRun): Effect.Effect<void> =>
        Effect.gen(function* () {
          const ended = live.plane.awaitRunEnd(live.meta.runId).pipe(Effect.as('ended' as const));
          while (!live.plane.getRunOutcome(live.meta.runId)) {
            const changed = Deferred.await(live.changed).pipe(Effect.as('changed' as const));
            const next =
              live.streams > 0
                ? yield* Effect.raceFirst(changed, ended)
                : yield* Effect.raceAll([
                    changed,
                    ended,
                    Effect.sleep(Duration.millis(reconnectMillis)).pipe(
                      Effect.as('expired' as const),
                    ),
                  ]);
            if (next === 'expired') return;
          }
        });

      // Once the stream stops being read (or setup fails), its run, if still going, is cancelled:
      // at once, or after `reconnectWindow` without a resumed stream. The subscription shuts down
      // first so a stream nobody reads cannot block the run-end event.
      const closeStream = Effect.gen(function* () {
        yield* Queue.shutdown(dequeue);
        const run = ownRun();
        if (!run || plane.getRunOutcome(run.runId)) return;
        const reason = signal?.aborted ? 'client-abort' : 'stream-closed';
        if (liveRun) {
          changeStreams(liveRun, -1);
          if (reconnectMillis > 0) yield* awaitReconnects(liveRun);
        }
        if (!plane.getRunOutcome(run.runId)) {
          yield* plane.endRun(run, { status: 'cancelled', payload: { reason } });
        }
      });

      return yield* Effect.gen(function* () {
        if (onRequest) {
          yield* Effect.tryPromise(() =>
            Promise.resolve(
              onRequest({
                setRunId,
                setContextId,
                emitStartEvent,
                req,
                principal,
                payload,
              }),
            ),
          );
        } else if (startEvent) {
          const envelope: Envelope = {
            name: startEvent.name,
            meta: {
              ...withPrincipal({ runId: runState.runId, contextId: runState.contextId }),
              eventId: crypto.randomUUID(),
            },
            payload: startEvent.payload,
          };
          refuseUnstorable(envelope, startEvent.at);
          yield* Effect.promise(startTracedRun);
          claim(runState.runId);
          runState.startId = sseEventId(envelope.meta);
          runState.started = true;
          limitRun(runState.runId);
          yield* plane.publish(targetChannel, envelope);
        }
        yield* Effect.promise(startTracedRun);

        const run = ownRun();
        if (run) {
          yield* Effect.forkScoped(plane.superviseRun(run, { idleTimeout, maxDuration }));
        }

        // Live events leave in their wire form: what a resumed stream replays from the store.
        const take = async (): Promise<Envelope> =>
          wireEnvelope(plane, await Effect.runPromise(Queue.take(dequeue)));

        const stream = createExposedStream({
          take,
          signal,
          eventFilter,
          runId: run?.runId,
          idOf: idOfOn(plane),
          startId: run ? runState.startId : undefined,
        });
        if (consumer) {
          return yield* Effect.tryPromise(() => consumer(stream));
        }
        return stream;
      }).pipe(Effect.ensuring(closeStream));
    }).pipe(
      Effect.tapError((e) =>
        Effect.sync(() => {
          runState.error = e instanceof Error ? e : new Error(String(e));
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (liveRun && liveRuns.get(liveRun.meta.runId) === liveRun) {
            liveRuns.delete(liveRun.meta.runId);
          }
        }),
      ),
      Effect.ensuring(
        Effect.promise(async () => {
          // A request that failed before its run started still gets a (failed) trace, unless
          // it was refused as invalid.
          if (runState.error && !runState.refused) startTracedRun();
          if (tracedRunStarted && tracedRun) {
            await tracedRunStarted;
            const outcome = ownedRun?.plane.getRunOutcome(ownedRun.meta.runId);
            await networkTracer.onRunEnd(tracedRun, runState.error ?? outcomeError(outcome), {
              status: runState.error ? 'error' : outcomeTraceStatus(outcome),
            });
          }
          await networkTracer.flush();
        }),
      ),
    );

    const runnable = tracingLayer
      ? program.pipe(Effect.provide(tracingLayer), Effect.scoped)
      : program.pipe(Effect.scoped);
    const exit = await Effect.runPromiseExit(runnable);
    if (Exit.isSuccess(exit)) return exit.value;
    // A refused run (403) or start event (400) reaches adapters as the typed error it is.
    throw exposeErrorIn(exit.cause) ?? Runtime.makeFiberFailure(exit.cause);
  };

  /**
   * A reconnected stream (`Last-Event-ID` = `position`): replays the run's durable events of this
   * stream's channel after `position` from the store, in the namespace of the request's principal,
   * then streams the run live while it goes on here, else ends with its run-end event. Starts and
   * publishes nothing. `ExposeRunNotFoundError` when the principal has no such run or position.
   */
  const resumeStream = async (
    position: string,
    req: ExposeRequest,
    principal: Principal | undefined,
    consumer?: (stream: ExposedStream) => Promise<unknown>,
  ): Promise<unknown> => {
    const target = parseSseEventId(position);
    if (!target) throw new ExposeRunNotFoundError();
    const { runId, contextId } = target;
    const principalId = principal?.id;
    const channel = channels[0];
    if (!channel) throw new Error('expose: no channels to subscribe to');
    const channelDef = network.getChannels().get(channel);

    /** The plane running the run for this principal right now, if any. */
    const findLive = (): { plane: EventPlane; live?: LiveRun } | undefined => {
      const live = liveRuns.get(runId);
      if (
        live &&
        live.principalId === principalId &&
        live.meta.contextId === contextId &&
        !live.plane.getRunOutcome(runId)
      ) {
        return { plane: live.plane, live };
      }
      const info = providedPlane && inspectRun(providedPlane, runId);
      if (providedPlane && info && !info.outcome && info.principalId === principalId) {
        return { plane: providedPlane };
      }
      return undefined;
    };

    /** True for stored events this stream would have carried (see `StoredEvent.channels`). */
    const onStream = (event: StoredEvent): boolean => {
      if (isRunEndEnvelope(event)) return true;
      // Published to no channel, whatever the store kept: never streamed.
      if (isFoldCheckpointEvent(event)) return false;
      const onChannel = event.channels
        ? event.channels.includes(channel)
        : // Stored without channels: lifecycle events, and agents' events the channel accepts.
          isRunLifecycleEnvelope(event) ||
          ((event.meta.depth ?? 0) > 0 &&
            (!channelDef || channelAcceptsEvent(channelDef, event.name)));
      return onChannel && (!eventFilter?.length || eventFilter.includes(event.name));
    };

    const program = Effect.gen(function* () {
      const running = findLive();
      // Subscribed before reading the store, so nothing published in between is missed.
      const dequeue = running
        ? yield* running.plane.subscribe(
            channel,
            (envelope) =>
              envelope.meta.runId === runId && envelope.meta.principalId === principalId,
          )
        : undefined;
      const live = running?.live;
      if (live) {
        changeStreams(live, 1);
        yield* Effect.addFinalizer(() => Effect.sync(() => changeStreams(live, -1)));
      }

      const stored = yield* Effect.promise(() =>
        store.readRun(storeKeyOf({ contextId, principalId }), runId),
      );
      const at = stored.findIndex((event) => event.meta.eventId === target.eventId);
      const resumedAt = stored[at];
      if (!resumedAt) throw new ExposeRunNotFoundError();

      const seen = new Set<string>();
      const replay: Envelope[] = [];
      for (const event of stored.slice(at + 1)) {
        const id = event.meta.eventId;
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        if (onStream(event)) replay.push(toEnvelope(event));
      }
      // A stream of an ended run always ends with its run-end event, even resumed right at it.
      const ended = replay.some(isRunEndEnvelope) || isRunEndEnvelope(resumedAt);
      if (isRunEndEnvelope(resumedAt)) replay.push(toEnvelope(resumedAt));

      const meta: EventMeta = {
        runId,
        contextId,
        ...(principalId !== undefined && { principalId }),
      };
      let streamPlane = running?.plane;
      if (!ended && !running) {
        // Not running here and never ended in the store: end the stream (only) with what is known.
        const outcome = providedPlane?.getRunOutcome(runId);
        const trailer = outcome ? runEndEnvelope(meta, outcome) : runUnavailableEnvelope(meta);
        synthetic.add(trailer);
        replay.push(trailer);
        streamPlane = providedPlane;
      }

      const stream = createExposedStream({
        replay,
        // The run goes on here: its live events follow, in their wire form like the replay.
        take:
          !ended && running && dequeue
            ? async () => wireEnvelope(running.plane, await Effect.runPromise(Queue.take(dequeue)))
            : undefined,
        seen,
        signal: req.request?.signal,
        eventFilter,
        runId,
        idOf: idOfOn(streamPlane),
      });
      if (consumer) return yield* Effect.tryPromise(() => consumer(stream));
      return stream;
    });

    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped));
    if (Exit.isSuccess(exit)) return exit.value;
    throw exposeErrorIn(exit.cause) ?? Runtime.makeFiberFailure(exit.cause);
  };

  const api = {
    protocol: 'sse',
    logger,
    createStream: (async (
      req: ExposeRequest,
      consumer?: (stream: ExposedStream) => Promise<unknown>,
    ) => {
      let principal: Principal | undefined;
      if (auth) {
        const result = await auth(req);
        if (!result.allowed) {
          throw new ExposeAuthError(result.message ?? 'Unauthorized', result.status ?? 401);
        }
        if (result.principal !== undefined) {
          assertPrincipal(result.principal, 'expose auth');
          principal = result.principal;
        }
      }
      return createStream(req, principal, consumer);
    }) as StreamFactory,
    ...createInboundPublisher({ plane: providedPlane, network, channels: [...channels] }),
    ...(providedPlane ? { plane: providedPlane } : {}),
  } satisfies InteractiveProxyHandle;

  return api;
}

/**
 * Expose the agent network as a streamable API. Returns an InteractiveProxyHandle that
 * adapters (NextEndpoint, ExpressEndpoint) consume to produce streamed responses.
 *
 * @example
 * const api = network.expose(registerSSEStream({ channel: "client", auth }));
 * export const GET = NextEndpoint.from(api, { requestToContextId, requestToRunId }).handler();
 */
export function expose<TDeps extends DependencyLayerDef<string, unknown, S.Schema.Any>>(
  network: AgentNetwork<TDeps>,
  consumer: ProxyConsumer<TDeps>,
): InteractiveProxyHandle {
  if (consumer._tag === 'BuiltinProxyConsumer' && consumer.kind === 'sse') {
    const channels = resolveChannelsForProxyKind(network, 'sse', consumer.options.channel);
    return createInteractiveStream(network, channels, consumer.options);
  }

  if (consumer._tag === 'CustomProxyConsumer') {
    const channels = resolveChannelsForProxyKind(network, consumer.kind, consumer.options.channel);
    return consumer.expose(
      createProxyExposeContext({
        network,
        channels,
        options: consumer.options,
        createInteractiveStream: (opts) => createInteractiveStream(network, channels, opts),
      }),
    );
  }

  throw new Error('expose: unsupported proxy consumer');
}

/**
 * The `ExposeAuthError` or `ExposeValidationError` that failed a request, also when user code
 * (`onRequest`) let it through.
 */
function exposeErrorIn(
  cause: Cause.Cause<unknown>,
): ExposeAuthError | ExposeValidationError | ExposeRunNotFoundError | undefined {
  const isExposeError = (
    e: unknown,
  ): e is ExposeAuthError | ExposeValidationError | ExposeRunNotFoundError =>
    e instanceof ExposeAuthError ||
    e instanceof ExposeValidationError ||
    e instanceof ExposeRunNotFoundError;
  for (const failure of [...Cause.failures(cause), ...Cause.defects(cause)]) {
    if (isExposeError(failure)) return failure;
    const wrapped = (failure as { error?: unknown } | null)?.error;
    if (isExposeError(wrapped)) return wrapped;
  }
  return undefined;
}

/** Thrown when auth denies the request */
export class ExposeAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = 'ExposeAuthError';
  }
}

/** JSON body of a 400 response for a request `expose()` refused (see `ExposeValidationError`). */
export type ExposeValidationErrorBody = {
  readonly error: 'invalid_request';
  readonly issues: ReadonlyArray<ValidationIssue>;
};

/**
 * Thrown (by `createStream`) when a request's payload is malformed JSON or does not match the
 * trigger event's schema, or when `emitStartEvent` is given an event its schema rejects or a
 * reserved `m4trix:` name (issue path `name`). Nothing
 * ran: no run, no agent, no trace. `NextEndpoint` and `ExpressEndpoint` answer it with a 400 and
 * `toJSON()` as the body; custom proxies can do the same.
 */
export class ExposeValidationError extends Error {
  readonly _tag = 'ExposeValidationError' as const;
  readonly status = 400 as const;
  readonly issues: ReadonlyArray<ValidationIssue>;

  constructor(issues: ReadonlyArray<ValidationIssue>) {
    super('Invalid request');
    this.name = 'ExposeValidationError';
    this.issues = issues;
  }

  /** The response body: `{ error: 'invalid_request', issues }`. */
  toJSON(): ExposeValidationErrorBody {
    return { error: 'invalid_request', issues: this.issues };
  }
}

/** JSON body of a 404 response for a resume `expose()` found nothing to resume. */
export type ExposeRunNotFoundErrorBody = { readonly error: 'run_not_found' };

/**
 * Thrown (by `createStream`) for a reconnect (`Last-Event-ID`) whose run or position the request's
 * principal does not have: an unknown or expired run, another principal's run (never told apart,
 * so run ids leak nothing), or an id not made by `sseEventId`. `NextEndpoint` and
 * `ExpressEndpoint` answer it with a 404, which makes `EventSource` stop reconnecting.
 */
export class ExposeRunNotFoundError extends Error {
  readonly _tag = 'ExposeRunNotFoundError' as const;
  readonly status = 404 as const;

  constructor() {
    super('Run not found');
    this.name = 'ExposeRunNotFoundError';
  }

  /** The response body: `{ error: 'run_not_found' }`. */
  toJSON(): ExposeRunNotFoundErrorBody {
    return { error: 'run_not_found' };
  }
}

/** A stored event as the envelope a stream yields (without its storage-only `channels`). */
function toEnvelope(event: StoredEvent): Envelope {
  const { channels: _channels, ...envelope } = event;
  return envelope;
}
