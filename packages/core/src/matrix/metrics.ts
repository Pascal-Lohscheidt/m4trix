import type { NetworkLogger } from './logger.js';
import type { NetworkTraceStatus } from './tracing/network-tracer.js';

/** How a run ended, as metric attribute. */
export type RunMetricStatus = 'completed' | 'failed' | 'cancelled';

type Metric<
  TName extends string,
  TKind extends 'histogram' | 'counter',
  TUnit extends string,
  TAttributes,
> = {
  readonly name: TName;
  /** The instrument that fits: a histogram records a distribution, a counter adds up. */
  readonly kind: TKind;
  /** UCUM-style unit, as OpenTelemetry expects it. */
  readonly unit: TUnit;
  readonly value: number;
  /** Low-cardinality attributes only: never payloads, run ids or principals. */
  readonly attributes: TAttributes;
};

/**
 * A measurement of a network, passed to the `onMetric` setup option. Vendor-neutral: map it onto
 * OpenTelemetry, Prometheus, StatsD, ... by `name` (stable), `kind` and `unit`.
 *
 * - `m4trix.run.duration_ms`: first event to run end, per run. `reason` is the completion reason
 *   (`terminal-event` / `agent`), the failure kind (`agent-error`, `idle-timeout`, ...) or the
 *   cancel reason (`client-abort` / `stream-closed`).
 * - `m4trix.run.events`: events published in the run, once per `durability` at run end.
 * - `m4trix.run.tokens` / `m4trix.run.cost_usd`: the run's reported usage at run end (only when
 *   something was reported).
 * - `m4trix.agent.invocation.duration_ms`: one agent invocation, with its outcome.
 * - `m4trix.mailbox.depth`: events queued for an agent in a run, sampled on every enqueue.
 * - `m4trix.store.append.duration_ms`: one durable event's store write, retries included.
 * - `m4trix.store.append.errors`: one failed write attempt; `final` when no retry follows.
 * - `m4trix.fold.read.events`: events one `ctx.folds` read folded, by fold name and `start`:
 *   `cold` (nothing cached: from the newest checkpoint or the start), `warm` (continued the cached
 *   state) or `reset` (the cached state belonged to a deleted or expired history and was rebuilt).
 *   Many cold reads point at a `foldCache` too small for the traffic.
 * - `m4trix.fold.read.skipped`: an event a `ctx.folds` read left out of a fold, by fold name and
 *   `reason`: `decode` (a stored event whose payload no longer decodes with its event's schema),
 *   `checkpoint` (a checkpoint that cannot be restored) or `missing-segment` (an event a segmented
 *   fold's `attach` found no segment for, with `onMissing: 'report'`, the default). Counted (and
 *   logged) once per event, fold and reason while the event plane remembers it: the last 1000
 *   it reported, the least recently seen forgotten first. Old history never breaks a read.
 */
export type NetworkMetric =
  | Metric<
      'm4trix.run.duration_ms',
      'histogram',
      'ms',
      { readonly status: RunMetricStatus; readonly reason: string }
    >
  | Metric<
      'm4trix.run.events',
      'histogram',
      '{event}',
      { readonly status: RunMetricStatus; readonly durability: 'durable' | 'transient' }
    >
  | Metric<
      'm4trix.run.tokens',
      'histogram',
      '{token}',
      { readonly status: RunMetricStatus; readonly type: 'input' | 'output' | 'total' }
    >
  | Metric<'m4trix.run.cost_usd', 'histogram', 'USD', { readonly status: RunMetricStatus }>
  | Metric<
      'm4trix.agent.invocation.duration_ms',
      'histogram',
      'ms',
      { readonly agentId: string; readonly status: NetworkTraceStatus }
    >
  | Metric<'m4trix.mailbox.depth', 'histogram', '{event}', { readonly agentId: string }>
  | Metric<
      'm4trix.store.append.duration_ms',
      'histogram',
      'ms',
      { readonly status: 'ok' | 'error' }
    >
  | Metric<'m4trix.store.append.errors', 'counter', '{error}', { readonly final: boolean }>
  | Metric<
      'm4trix.fold.read.events',
      'histogram',
      '{event}',
      { readonly fold: string; readonly start: 'cold' | 'warm' | 'reset' }
    >
  | Metric<
      'm4trix.fold.read.skipped',
      'counter',
      '{event}',
      { readonly fold: string; readonly reason: 'decode' | 'checkpoint' | 'missing-segment' }
    >;

export type NetworkMetricName = NetworkMetric['name'];

/** Receives the network's metrics (see `NetworkMetric`). */
export type NetworkMetricHandler = (metric: NetworkMetric) => void;

/**
 * @internal `handler` guarded: a throwing handler never fails the network; its first failure is
 * logged, later ones are not (a broken metrics backend would flood the log otherwise).
 * `undefined` without a handler, so call sites skip building metrics.
 */
export function guardMetricHandler(
  handler: NetworkMetricHandler | undefined,
  logger: Pick<NetworkLogger, 'warn'>,
): NetworkMetricHandler | undefined {
  if (!handler) return undefined;
  let reported = false;
  return (metric) => {
    try {
      handler(metric);
    } catch (error) {
      if (reported) return;
      reported = true;
      logger.warn('[m4trix] onMetric threw; ignoring it (further failures are not logged):', error);
    }
  };
}
