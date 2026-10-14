/**
 * A recorded run of a docs snippet: `content/runs/<id>.json`, written by
 * `scripts/record-docs-runs.mts` (`pnpm --filter website docs:record`). The run player, the
 * network diagram and the walkthrough read it. Contract: `ops-docs/docs-pilot-spec.md`.
 *
 * Kept free of imports so client and server code (and the recorder) can share it.
 */
export interface DocsRun {
  version: 1;
  /** The snippet path without `.ts`, e.g. `'concepts/channels'`. */
  id: string;
  /** The snippet path under `content/snippets`, e.g. `'concepts/channels.ts'`. */
  snippet: string;
  topology: DocsRunTopology;
  /** Every event published in the run, in publish order. */
  events: DocsRunEvent[];
  /** How the run ended, e.g. `'m4trix:run.completed'`. */
  end: { name: string };
  /** One Markdown sentence per event, names in backticks. Generated, not hand-written. */
  walkthrough: string[];
}

export interface DocsRunTopology {
  mainChannel: string;
  /** In the order the network creates them, main first. */
  channels: DocsRunChannel[];
  /** In registration order. */
  agents: DocsRunAgent[];
  /** Events declared with `endsOn`. */
  terminalEvents: string[];
}

export interface DocsRunChannel {
  name: string;
  /** The `.events([...])` declaration; `null` = carries every event. */
  events: string[] | null;
  /** Proxy kinds, e.g. `['sse']`. */
  proxies: string[];
}

export interface DocsRunAgent {
  /** Export name in the snippet. */
  name: string;
  /** `null` = catch-all (no `listensTo`): every event on the channels it subscribes to. */
  listensTo: string[] | null;
  /** Events it (and its tools) may emit; `null` when the agent doesn't declare them. */
  emits: string[] | null;
  /** Channel names. */
  subscribes: string[];
  publishesTo: string[];
}

export interface DocsRunEvent {
  /** Publish order, 0-based. */
  i: number;
  name: string;
  /** Channels it was published on, in topology order. */
  channels: string[];
  /** Agent name; `null` = published from outside the network (the scenario) or by the runtime. */
  by: string | null;
  /** Index of the event whose handling emitted it. */
  cause: number | null;
  payload: unknown;
  /** Agents invoked with this event, in invocation order. */
  deliveredTo: string[];
  /** 1-based line in the snippet file that creates it (the emit call or the scenario). */
  line: number | null;
  /**
   * Set on a reply: the agent that published the request with `emitAndAwait` and receives this
   * event as its answer (matched by `meta.correlationId`, not by subscription).
   */
  replyTo?: string;
}
