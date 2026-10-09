import recording from '@/data/agent-run.json';

/* Shapes written by scripts/record-agent-run.mts */

export type RunEvent = {
  i: number;
  t: number;
  name: string;
  channels: string[];
  by: string;
  payload: Record<string, unknown>;
};

export type Invocation = {
  lane: string;
  channel: string;
  trigger: number;
  start: number;
  end: number;
};

/** A mocked model call, recorded through the agent's tracing scope. */
export type Span = { lane: string; name: string; start: number; end: number };

export type Run = {
  duration: number;
  events: RunEvent[];
  invocations: Invocation[];
  spans: Span[];
};

export type Decision = 'approved' | 'denied';

export const RUNS = recording.branches as unknown as Record<Decision, Run>;

export const PROMPT = recording.prompt;

/** Time an event takes on screen to travel from its emitter, along the channel, to a receiver. */
export const TRAVEL = 340;
/** Shortest time a receiving agent stays lit, so near-instant handlers still register. */
export const GLOW_MIN = 220;

export const reqIndex = (run: Run) => run.events.findIndex((e) => e.name === 'approval-requested');

/** The invocation an event was emitted from: same lane, and the event falls inside its run. */
function sourceOf(run: Run, e: RunEvent): Invocation | undefined {
  return run.invocations.find((inv) => inv.lane === e.by && inv.start <= e.t && e.t <= inv.end + 2);
}

export type VisualTimes = {
  /** When each event leaves its emitter on screen. */
  event: number[];
  /** When the triggering packet reaches each invocation's agent. */
  arrive: Map<Invocation, number>;
};

/**
 * The recorded clock is real, but on screen packets need TRAVEL ms to reach their receiver. To keep
 * cause before effect, an event cannot leave before the packet that triggered its emitter arrived.
 * Real gaps are mostly longer than TRAVEL, so this rarely moves anything.
 */
export function visualTimes(run: Run): VisualTimes {
  const event: number[] = [];
  const arrive = new Map<Invocation, number>();
  const lastByLane = new Map<string, number>();
  const req = reqIndex(run);

  for (const e of run.events) {
    let vt = e.t;
    const source = sourceOf(run, e);
    if (source && source.trigger >= 0 && source.trigger < e.i) {
      vt = Math.max(vt, event[source.trigger] + TRAVEL);
    }
    // The person answers the approval card only after it reached the browser.
    if (e.name === 'approval-resolved' && req >= 0 && req < e.i) {
      vt = Math.max(vt, event[req] + TRAVEL);
    }
    vt = Math.max(vt, lastByLane.get(e.by) ?? 0);
    lastByLane.set(e.by, vt);
    event.push(vt);
  }

  for (const inv of run.invocations) {
    if (inv.trigger >= 0) arrive.set(inv, event[inv.trigger] + TRAVEL);
  }
  return { event, arrive };
}

const settle = TRAVEL + GLOW_MIN + 60;

/** Where a replay ends: after the last packet landed and its receiver dimmed again. */
export const endOf = (run: Run) => Math.max(...visualTimes(run).event) + settle;

/** Where the replay pauses for approval: once the request has reached the browser. */
export const pauseOf = (run: Run) => visualTimes(run).event[reqIndex(run)] + settle;

// One x-scale for both branches, so switching at the approval does not rescale the timeline.
export const SCALE = Math.max(endOf(RUNS.approved), endOf(RUNS.denied));
