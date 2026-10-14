import type { DocsRun, DocsRunAgent, DocsRunEvent, DocsRunTopology } from './types';

/**
 * Auto-layout of a recorded run's topology for `<NetworkDiagram>` and `<RunPlayer>`, in the
 * canvas pixels of `docs-visual-gen/lib`. Pure and deterministic: the same run always gives the
 * same picture, so nothing is placed by hand.
 *
 * - Channels are horizontal lanes stacked top to bottom, `main` first. The other lanes are
 *   ordered so that every agent's channels sit next to each other where possible.
 * - Consecutive lanes overlap in a band when an agent uses both: the agent sits in that band,
 *   inside the lane it subscribes to and the lane it publishes to (or, for an agent that only
 *   subscribes, like a catch-all, the lanes it reads). An agent with a single channel sits in a
 *   band of its own lane below the lane's rail.
 * - Agents get columns by flow depth (how many hops from `main`), so a run reads left to right;
 *   two agents never share a column within a band. Each lane spans the columns it touches,
 *   which gives the staircase of the docs-visual-gen scenes.
 * - `expose()` is a port on the network's left border at `main`; each proxy is a port on the
 *   right border at its lane. The outside world is left of `expose()`.
 * - Every event gets token paths: from its publisher (an agent, the outside or the runtime)
 *   onto its channel's rail, along the rail, then to each agent it was delivered to and out
 *   through the channel's proxy.
 */

export type LaneTone = 'sand' | 'rose' | 'mint';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaneLayout {
  name: string;
  tone: LaneTone;
  box: Box;
  /** y of the lane's rail: the line events travel along. */
  railY: number;
  labelEdge: 'top' | 'bottom';
  /** Label offset from the box's left edge. */
  labelOffset: number;
}

export interface AgentLayout {
  name: string;
  at: Point;
  /** Estimated chip width. */
  width: number;
}

export type PortKind = 'expose' | 'sse' | 'custom';

export interface PortLayout {
  /** `expose` or `proxy:<channel>:<kind>`. */
  id: string;
  kind: PortKind;
  channel: string;
  label: string;
  at: Point;
}

/** A small arrowhead on a wire: into an agent (subscribe) or into a rail (publish). */
export interface ArrowLayout {
  at: Point;
  dir: 'up' | 'down' | 'right';
}

/** Where a token crosses a port on its path, as a fraction of the path's length. */
export interface PortMark {
  port: string;
  at: number;
}

export interface TokenPath {
  /** `enter`: publisher → rail → resting point. `copy`: → an agent. `out`: → through a proxy. */
  kind: 'enter' | 'copy' | 'out';
  points: Point[];
  /** Arc length in canvas px. */
  length: number;
  /** For `copy`: the agent it is delivered to. */
  agent?: string;
  ports: PortMark[];
}

export interface StepLayout {
  label: string;
  /** Run lifecycle (`m4trix:*`) event: neutral token, no travel. */
  runtime: boolean;
  /** One per channel the event travels on; `copy` / `out` paths start where these end. */
  enter: TokenPath[];
  branches: TokenPath[][];
  /** Where the event rests once delivered (one per channel). */
  rest: Point[];
  /** Agents lit for this step. */
  agents: string[];
  /** Port ids lit for this step. */
  ports: string[];
}

export interface RunLayout {
  width: number;
  height: number;
  network: Box;
  lanes: LaneLayout[];
  agents: AgentLayout[];
  ports: PortLayout[];
  /** Dashed connectors: the outside → expose(), lane rails, agent ↔ rail stubs. */
  wires: string[];
  arrows: ArrowLayout[];
  steps: StepLayout[];
}

// ── Metrics of the docs-visual-gen components (JetBrains Mono, 0.6em advance) ──────────────

const AGENT_H = 74;
const agentWidth = (name: string) => Math.ceil(14 + 46 + 13 + name.length * 9.1 + 24);
export const tokenWidth = (label: string) => Math.ceil(5 + 25 + 8 + label.length * 7.6 + 14);
const tagWidth = (name: string) => Math.ceil(10 + 13 + 8 + (7 + name.length) * 7.85 + 2);
const portWidth = (label: string) => Math.ceil(6 + 30 + 9 + label.length * 8.2 + 16);

// ── Spacing ──────────────────────────────────────────────────────────────────────────────

const NET_Y = 40;
/** Network border → lanes. */
const INSET = 44;
/** Lane edge → agent chip. */
const LANE_PAD = 34;
/** Height of a lane's own band holding its rail. */
const RAIL_BAND = 80;
/** Band where two lanes overlap (holds agents). */
const OVERLAP_BAND = 120;
/** Band inside a single lane, below its rail (agents with one channel). */
const SOLO_BAND = 116;
/** Vertical gap between two lanes that don't overlap. */
const LANE_GAP = 26;
const COL_GAP = 64;
/** First column's left edge, from the network's left border. */
const FIRST_COL = 120;
const MIN_LANE_W = 280;
const TONES: LaneTone[] = ['sand', 'rose', 'mint'];

const RUNTIME_PREFIX = 'm4trix:';

export function isRuntimeEvent(event: DocsRunEvent): boolean {
  return event.by === null && event.name.startsWith(RUNTIME_PREFIX);
}

export function portLabel(kind: string): string {
  return kind === 'sse' ? 'proxy.sse()' : `proxy '${kind}'`;
}

// ── Lane order ───────────────────────────────────────────────────────────────────────────

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

function agentLanes(agent: DocsRunAgent): string[] {
  return [...new Set([...agent.subscribes, ...agent.publishesTo])];
}

/** `main` first; the rest ordered so each agent's lanes are adjacent and flow goes down. */
function orderLanes(topology: DocsRunTopology): string[] {
  const names = topology.channels.map((c) => c.name);
  const main = names.includes(topology.mainChannel) ? topology.mainChannel : names[0];
  const rest = names.filter((n) => n !== main);
  // Up to 6 other lanes are searched exhaustively; beyond that, keep the declared order.
  const candidates = rest.length <= 6 ? permutations(rest) : [rest];
  let best = [main, ...rest];
  let bestCost = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const order = [main, ...candidate];
    const index = new Map(order.map((n, i) => [n, i]));
    let cost = 0;
    for (const agent of topology.agents) {
      const lanes = agentLanes(agent)
        .map((l) => index.get(l))
        .filter((i) => i !== undefined);
      if (lanes.length < 2) continue;
      const span = Math.max(...lanes) - Math.min(...lanes);
      cost += (span - 1) * 100;
      // Publishing upwards reads against the flow.
      for (const s of agent.subscribes) {
        for (const p of agent.publishesTo) {
          const si = index.get(s);
          const pi = index.get(p);
          if (si !== undefined && pi !== undefined && pi < si) cost += 10;
        }
      }
    }
    // Tie-break: stay close to the order the network creates the channels in.
    order.forEach((n, i) => {
      cost += Math.abs(i - names.indexOf(n)) * 0.01;
    });
    if (cost < bestCost) {
      bestCost = cost;
      best = order;
    }
  }
  return best;
}

// ── Polylines ────────────────────────────────────────────────────────────────────────────

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
}

function polylineLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

/** Fraction of the path's length at which it passes `target` (which lies on the path). */
function fractionAt(points: Point[], target: Point): number {
  const total = polylineLength(points) || 1;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const onSegment =
      Math.abs(
        Math.hypot(target.x - a.x, target.y - a.y) +
          Math.hypot(b.x - target.x, b.y - target.y) -
          seg,
      ) < 0.5;
    if (onSegment) return (walked + Math.hypot(target.x - a.x, target.y - a.y)) / total;
    walked += seg;
  }
  return 1;
}

function path(
  kind: TokenPath['kind'],
  raw: Point[],
  extra: { agent?: string; ports?: Array<{ port: string; at: Point }> } = {},
): TokenPath {
  const points = dedupe(raw);
  return {
    kind,
    points,
    length: Math.round(polylineLength(points)),
    agent: extra.agent,
    ports: (extra.ports ?? []).map((p) => ({
      port: p.port,
      at: Math.round(fractionAt(points, p.at) * 1000) / 1000,
    })),
  };
}

// ── Layout ───────────────────────────────────────────────────────────────────────────────

type Band = { kind: 'overlap'; lane: number } | { kind: 'solo'; lane: number };

export function layoutRun(run: DocsRun): RunLayout {
  const { topology } = run;
  const order = orderLanes(topology);
  const laneIndex = new Map(order.map((n, i) => [n, i]));
  const channelOf = new Map(topology.channels.map((c) => [c.name, c]));
  const mainName = order[0];
  const agentsByName = new Map(topology.agents.map((a) => [a.name, a]));

  // Bands: an agent sits between its topmost lane and the next one, or alone in its lane.
  const bandOf = new Map<string, Band>();
  for (const agent of topology.agents) {
    const lanes = agentLanes(agent)
      .map((l) => laneIndex.get(l))
      .filter((i) => i !== undefined);
    if (!lanes.length) bandOf.set(agent.name, { kind: 'solo', lane: 0 });
    else if (Math.min(...lanes) === Math.max(...lanes)) {
      bandOf.set(agent.name, { kind: 'solo', lane: lanes[0] });
    } else {
      const top = Math.min(...lanes);
      bandOf.set(agent.name, { kind: 'overlap', lane: Math.min(top, order.length - 2) });
    }
  }
  const bandKey = (b: Band) => `${b.kind}:${b.lane}`;

  // Flow depth: hops from main (or from a lane nobody publishes to).
  const publishersOf = new Map<string, string[]>();
  for (const agent of topology.agents) {
    for (const lane of agent.publishesTo) {
      publishersOf.set(lane, [...(publishersOf.get(lane) ?? []), agent.name]);
    }
  }
  const laneDepth = new Map<string, number>();
  for (const name of order) {
    if (name === mainName || !publishersOf.get(name)?.length) laneDepth.set(name, 0);
  }
  const agentDepth = new Map<string, number>();
  for (let round = 0; round <= order.length + topology.agents.length; round++) {
    for (const agent of topology.agents) {
      const depths = agent.subscribes
        .map((l) => laneDepth.get(l))
        .filter((d): d is number => d !== undefined);
      if (!depths.length) continue;
      const depth = Math.min(...depths);
      agentDepth.set(agent.name, Math.min(agentDepth.get(agent.name) ?? depth, depth));
      for (const lane of agent.publishesTo) {
        if ((laneDepth.get(lane) ?? Number.POSITIVE_INFINITY) > depth + 1) {
          laneDepth.set(lane, depth + 1);
        }
      }
    }
  }

  // Columns: by depth, agents that publish before those that only listen, then registration.
  const placement = topology.agents
    .map((agent, index) => ({ agent, index }))
    .sort(
      (a, b) =>
        (agentDepth.get(a.agent.name) ?? 0) - (agentDepth.get(b.agent.name) ?? 0) ||
        Number(!a.agent.publishesTo.length) - Number(!b.agent.publishesTo.length) ||
        a.index - b.index,
    );
  // Vertical order of rails and bands, to keep an agent's wires (straight up or down to its
  // rails) from running through another agent in the same column.
  const rank = (band: Band) => band.lane * 3 + (band.kind === 'solo' ? 1 : 2);
  const wireSpans = (agent: DocsRunAgent): Array<[number, number]> => {
    const r = rank(bandOf.get(agent.name) as Band);
    return agentLanes(agent)
      .map((l) => laneIndex.get(l))
      .filter((i) => i !== undefined)
      .map((i) => [Math.min(r, i * 3), Math.max(r, i * 3)] as [number, number]);
  };
  const crosses = (spans: Array<[number, number]>, r: number) =>
    spans.some(([a, b]) => a < r && r < b);

  const colOf = new Map<string, number>();
  for (const { agent } of placement) {
    let col = agentDepth.get(agent.name) ?? 0;
    for (const lane of agent.subscribes) {
      for (const publisher of publishersOf.get(lane) ?? []) {
        const c = colOf.get(publisher);
        if (publisher !== agent.name && c !== undefined) col = Math.max(col, c + 1);
      }
    }
    const band = bandOf.get(agent.name) as Band;
    const spans = wireSpans(agent);
    const clashes = (c: number) =>
      topology.agents.some((other) => {
        if (colOf.get(other.name) !== c) return false;
        const otherBand = bandOf.get(other.name) as Band;
        return (
          bandKey(otherBand) === bandKey(band) ||
          crosses(spans, rank(otherBand)) ||
          crosses(wireSpans(other), rank(band))
        );
      });
    while (clashes(col)) col++;
    colOf.set(agent.name, col);
  }
  // Drop empty columns.
  const usedCols = [...new Set(colOf.values())].sort((a, b) => a - b);
  for (const [name, col] of colOf) colOf.set(name, usedCols.indexOf(col));
  const colCount = usedCols.length;

  // Horizontal metrics.
  const outsideEvents = run.events.filter((e) => e.by === null && !isRuntimeEvent(e));
  const outsideHalf = Math.max(0, ...outsideEvents.map((e) => tokenWidth(e.name) / 2));
  const exposeHalf = portWidth('expose()') / 2;
  const netX = Math.max(exposeHalf + 24, outsideHalf ? 16 + outsideHalf * 2 + 40 : 0);
  const outsideStart = { x: 16 + outsideHalf, y: 0 };

  const colWidth = Array.from({ length: colCount }, (_, c) =>
    Math.max(
      0,
      ...topology.agents.filter((a) => colOf.get(a.name) === c).map((a) => agentWidth(a.name)),
    ),
  );
  const colX: number[] = [];
  colWidth.forEach((w, c) => {
    colX.push(
      c === 0 ? netX + FIRST_COL + w / 2 : colX[c - 1] + colWidth[c - 1] / 2 + COL_GAP + w / 2,
    );
  });

  // Vertical: each lane is [rail band][solo band?] and shares an overlap band with the next
  // lane when an agent sits between them.
  const hasOverlap = (i: number) =>
    topology.agents.some((a) => {
      const b = bandOf.get(a.name);
      return b?.kind === 'overlap' && b.lane === i;
    });
  const hasSolo = (i: number) =>
    topology.agents.some((a) => {
      const b = bandOf.get(a.name);
      return b?.kind === 'solo' && b.lane === i;
    });
  const laneTop: number[] = [];
  const laneBottom: number[] = [];
  const railY: number[] = [];
  const soloY: number[] = [];
  const overlapY: number[] = [];
  const overlapTop: number[] = [];
  let y = NET_Y + 50;
  order.forEach((_, i) => {
    if (i === 0) laneTop.push(y);
    else if (hasOverlap(i - 1)) laneTop.push(overlapTop[i - 1]);
    else {
      y += LANE_GAP;
      laneTop.push(y);
    }
    railY.push(y + RAIL_BAND / 2);
    y += RAIL_BAND;
    if (hasSolo(i)) {
      soloY.push(y + SOLO_BAND / 2 - 8);
      y += SOLO_BAND;
    } else soloY.push(Number.NaN);
    if (i < order.length - 1 && hasOverlap(i)) {
      overlapTop.push(y);
      overlapY.push(y + OVERLAP_BAND / 2);
      y += OVERLAP_BAND;
    } else {
      overlapTop.push(Number.NaN);
      overlapY.push(Number.NaN);
    }
    laneBottom.push(
      i < order.length - 1 && hasOverlap(i) ? y : y + (i === order.length - 1 ? 8 : 0),
    );
  });

  const agents: AgentLayout[] = topology.agents.map((agent) => {
    const band = bandOf.get(agent.name) as Band;
    const col = colOf.get(agent.name) ?? 0;
    return {
      name: agent.name,
      at: {
        x: Math.round(colX[col]),
        y: Math.round(band.kind === 'overlap' ? overlapY[band.lane] : soloY[band.lane]),
      },
      width: agentWidth(agent.name),
    };
  });
  const agentAt = new Map(agents.map((a) => [a.name, a]));

  // Lane extents from what touches them.
  const attached = (lane: string) =>
    agents.filter((a) => agentLanes(agentsByName.get(a.name) as DocsRunAgent).includes(lane));
  const fedFromOutside = new Set([mainName, ...outsideEvents.flatMap((e) => e.channels)]);
  const proxied = (lane: string) => (channelOf.get(lane)?.proxies.length ?? 0) > 0;

  const laneLeft = order.map((lane) => {
    const items = attached(lane);
    if (fedFromOutside.has(lane) || !items.length) return netX + INSET;
    return Math.max(netX + INSET, Math.min(...items.map((a) => a.at.x - a.width / 2)) - LANE_PAD);
  });
  const contentRight = order.map((lane) => {
    const items = attached(lane);
    return items.length ? Math.max(...items.map((a) => a.at.x + a.width / 2)) + LANE_PAD : 0;
  });
  const proxyHalf = (lane: string) =>
    Math.max(0, ...(channelOf.get(lane)?.proxies ?? []).map((k) => portWidth(portLabel(k)) / 2));

  let netRight = Math.max(
    netX + INSET + MIN_LANE_W,
    ...order.map((lane, i) => {
      const minRight = laneLeft[i] + Math.max(MIN_LANE_W, tagWidth(lane) + 60);
      if (proxied(lane)) return Math.max(contentRight[i] + proxyHalf(lane) + 24, minRight);
      return Math.max(contentRight[i], minRight) + INSET;
    }),
  );
  netRight = Math.ceil(netRight);
  const laneRight = order.map((lane, i) => {
    if (proxied(lane)) return netRight + proxyHalf(lane) + 22;
    if (!attached(lane).length) return netRight - INSET;
    return Math.max(contentRight[i], laneLeft[i] + Math.max(MIN_LANE_W, tagWidth(lane) + 60));
  });

  // Ports.
  const ports: PortLayout[] = [
    {
      id: 'expose',
      kind: 'expose',
      channel: mainName,
      label: 'expose()',
      at: { x: netX, y: railY[0] },
    },
  ];
  order.forEach((lane, i) => {
    (channelOf.get(lane)?.proxies ?? []).forEach((kind, k) => {
      ports.push({
        id: `proxy:${lane}:${kind}`,
        kind: kind === 'sse' ? 'sse' : 'custom',
        channel: lane,
        label: portLabel(kind),
        at: { x: netRight, y: railY[i] + k * 50 },
      });
    });
  });
  const portOf = (lane: string) => ports.find((p) => p.channel === lane && p.id !== 'expose');

  // Where tokens that leave through a proxy end up: just outside the port.
  const outsideRest = (lane: string, label: string) => {
    const port = portOf(lane) as PortLayout;
    return {
      x: Math.round(port.at.x + proxyHalf(lane) + 26 + tokenWidth(label) / 2),
      y: port.at.y,
    };
  };

  // Runtime events rest on each lane's rail, in one column if every lane leaves room there,
  // clear of the lane's ends and its proxy port.
  const restRange = (i: number, half: number): [number, number] => {
    const port = portOf(order[i]);
    const right = port ? port.at.x - proxyHalf(order[i]) - 10 : laneRight[i] - 12;
    return [laneLeft[i] + 12 + half, right - half];
  };
  const runtimeXs = (lanes: number[], label: string): number[] => {
    const half = tokenWidth(label) / 2;
    const ranges = lanes.map((i) => restRange(i, half));
    const lo = Math.max(...ranges.map(([a]) => a));
    const hi = Math.min(...ranges.map(([, b]) => b));
    if (lo <= hi) return lanes.map(() => Math.round((lo + hi) / 2));
    return ranges.map(([a, b]) => Math.round((a + b) / 2));
  };

  // Steps.
  const steps: StepLayout[] = run.events.map((event) => {
    const lanes = event.channels.filter((c) => laneIndex.has(c));
    if (isRuntimeEvent(event)) {
      const indices = lanes.map((c) => laneIndex.get(c) as number);
      const xs = indices.length ? runtimeXs(indices, event.name) : [];
      const rest = indices.map((i, k) => ({ x: xs[k], y: railY[i] }));
      return {
        label: event.name,
        runtime: true,
        enter: rest.map((p) => path('enter', [p])),
        branches: rest.map(() => []),
        rest,
        agents: [],
        ports: lanes.flatMap((c) =>
          ports.filter((p) => p.channel === c && p.id !== 'expose').map((p) => p.id),
        ),
      };
    }

    const publisher = event.by ? agentAt.get(event.by) : undefined;
    // Each delivered agent takes the event from the first of its channels it subscribes to.
    const takesFrom = new Map<string, string>();
    for (const name of event.deliveredTo) {
      const agent = agentsByName.get(name);
      const lane = lanes.find((c) => agent?.subscribes.includes(c)) ?? lanes[0];
      if (lane) takesFrom.set(name, lane);
    }
    // A reply reaches the agent waiting in `emitAndAwait` from a lane it is wired to (it
    // published the request there), whether or not it subscribes to it.
    const receivers = [...event.deliveredTo];
    if (event.replyTo && !takesFrom.has(event.replyTo)) {
      const agent = agentsByName.get(event.replyTo);
      const lane = lanes.find((c) => agent && agentLanes(agent).includes(c)) ?? lanes[0];
      if (lane) {
        takesFrom.set(event.replyTo, lane);
        receivers.push(event.replyTo);
      }
    }

    const enter: TokenPath[] = [];
    const branches: TokenPath[][] = [];
    const rest: Point[] = [];
    const litPorts = new Set<string>();
    for (const lane of lanes) {
      const i = laneIndex.get(lane) as number;
      const ry = railY[i];
      const targets = receivers
        .filter((n) => takesFrom.get(n) === lane)
        .map((n) => agentAt.get(n) as AgentLayout);
      const port = portOf(lane);

      // From the publisher onto the rail.
      const start: Point[] = [];
      const enterPorts: Array<{ port: string; at: Point }> = [];
      if (publisher) {
        start.push(publisher.at, { x: publisher.at.x, y: ry });
      } else if (lane === mainName) {
        start.push({ x: outsideStart.x, y: ry }, { x: netX, y: ry });
        enterPorts.push({ port: 'expose', at: { x: netX, y: ry } });
        litPorts.add('expose');
      } else {
        start.push({ x: laneLeft[i] + 24, y: ry });
      }

      // Resting point: between the agents it reaches, else outside its proxy, else the rail's end.
      let restAt: Point;
      let leaves = false;
      if (targets.length) {
        const xs = targets.map((t) => t.at.x);
        restAt = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: ry };
      } else if (port) {
        restAt = outsideRest(lane, event.name);
        leaves = true;
      } else {
        restAt = { x: Math.round(laneRight[i] - 30 - tokenWidth(event.name) / 2), y: ry };
      }
      if (leaves && port) {
        enterPorts.push({ port: port.id, at: port.at });
        litPorts.add(port.id);
        enter.push(path('enter', [...start, port.at, restAt], { ports: enterPorts }));
      } else {
        enter.push(path('enter', [...start, restAt], { ports: enterPorts }));
      }
      rest.push(restAt);

      const branch: TokenPath[] = targets.map((t) =>
        path('copy', [restAt, { x: t.at.x, y: ry }, t.at], { agent: t.name }),
      );
      // Delivered and streamed out: a copy leaves through the proxy too.
      if (targets.length && port) {
        const beyond = outsideRest(lane, event.name);
        branch.push(
          path('out', [restAt, port.at, beyond], { ports: [{ port: port.id, at: port.at }] }),
        );
        litPorts.add(port.id);
      }
      branches.push(branch);
    }

    return {
      label: event.name,
      runtime: false,
      enter,
      branches,
      rest,
      agents: receivers,
      ports: [...litPorts],
    };
  });

  // Wires: outside → expose(), rails, agent stubs; arrowheads show subscribe / publish.
  const wires: string[] = [];
  const arrows: ArrowLayout[] = [];
  const stubs: Array<{ x: number; y1: number; y2: number }> = [];
  if (outsideHalf) wires.push(`M ${outsideStart.x} ${railY[0]} H ${netX}`);
  order.forEach((lane, i) => {
    const from = lane === mainName ? netX : laneLeft[i] + 24;
    const port = portOf(lane);
    const to = port
      ? Math.max(
          port.at.x,
          ...steps
            .flatMap((s) => s.rest)
            .filter((p) => p.y === railY[i])
            .map((p) => p.x),
        )
      : laneRight[i] - 24;
    wires.push(`M ${Math.round(from)} ${railY[i]} H ${Math.round(to)}`);
  });
  for (const agent of agents) {
    const spec = agentsByName.get(agent.name) as DocsRunAgent;
    for (const lane of agentLanes(spec)) {
      const i = laneIndex.get(lane);
      if (i === undefined) continue;
      const ry = railY[i];
      const below = ry > agent.at.y;
      const edge = agent.at.y + (below ? AGENT_H / 2 : -AGENT_H / 2);
      wires.push(`M ${agent.at.x} ${edge} V ${ry}`);
      stubs.push({ x: agent.at.x, y1: edge, y2: ry });
      // Subscribed: arrow into the agent; publishes: arrow into the rail. Both: no arrow.
      const subscribes = spec.subscribes.includes(lane);
      const publishes = spec.publishesTo.includes(lane);
      if (subscribes && !publishes) {
        arrows.push({
          at: { x: agent.at.x, y: edge + (below ? 7 : -7) },
          dir: below ? 'up' : 'down',
        });
      } else if (publishes && !subscribes) {
        arrows.push({
          at: { x: agent.at.x, y: ry + (below ? -9 : 9) },
          dir: below ? 'down' : 'up',
        });
      }
    }
  }

  // Labels sit on a lane's top edge (the last lane's on its bottom edge when it shares its top
  // with the lane above), at the first spot clear of agent chips, wires crossing the edge and
  // other labels; failing that, on the other edge.
  const placed: Array<{ x0: number; x1: number; y: number }> = [];
  const lanesOut: LaneLayout[] = order.map((name, i) => {
    const box = {
      x: Math.round(laneLeft[i]),
      y: Math.round(laneTop[i]),
      w: Math.round(laneRight[i] - laneLeft[i]),
      h: Math.round(laneBottom[i] - laneTop[i]),
    };
    const width = tagWidth(name);
    const blockersAt = (y: number) =>
      [
        ...agents
          .filter((a) => Math.abs(a.at.y - y) < AGENT_H / 2 + 15 + 12)
          .map((a) => [a.at.x - a.width / 2 - 14, a.at.x + a.width / 2 + 14] as const),
        ...stubs
          .filter((st) => Math.min(st.y1, st.y2) < y + 15 && Math.max(st.y1, st.y2) > y - 15)
          .map((st) => [st.x - 12, st.x + 12] as const),
        ...placed.filter((p) => Math.abs(p.y - y) < 34).map((p) => [p.x0 - 12, p.x1 + 12] as const),
      ].sort((a, b) => a[0] - b[0]);
    const spot = (y: number) => {
      const blockers = blockersAt(y);
      return [box.x + 22, ...blockers.map(([, r]) => r + 4)].find(
        (x) =>
          x >= box.x + 16 &&
          x + width <= box.x + box.w - 16 &&
          !blockers.some(([l, r]) => x < r && x + width > l),
      );
    };
    const sharesTop = i > 0 && hasOverlap(i - 1);
    const edges: Array<'top' | 'bottom'> =
      i === order.length - 1 && sharesTop ? ['bottom', 'top'] : ['top', 'bottom'];
    let labelEdge = edges[0];
    let labelOffset = 22;
    for (const edge of edges) {
      const x = spot(edge === 'top' ? box.y : box.y + box.h);
      if (x !== undefined) {
        labelEdge = edge;
        labelOffset = Math.round(x - box.x);
        break;
      }
    }
    const labelY = labelEdge === 'top' ? box.y : box.y + box.h;
    placed.push({ x0: box.x + labelOffset, x1: box.x + labelOffset + width, y: labelY });
    return {
      name,
      tone: TONES[i % TONES.length],
      box,
      railY: railY[i],
      labelEdge,
      labelOffset,
    };
  });

  const network = {
    x: netX,
    y: NET_Y,
    w: netRight - netX,
    h: Math.round(laneBottom[laneBottom.length - 1] + 36 - NET_Y),
  };
  const rightmost = Math.max(
    netRight + 40,
    ...lanesOut.map((l) => l.box.x + l.box.w + 24),
    ...steps.flatMap((s) => s.rest.map((p) => p.x + tokenWidth(s.label) / 2 + 20)),
  );

  return {
    width: Math.ceil(rightmost),
    height: Math.ceil(network.y + network.h + 34),
    network,
    lanes: lanesOut,
    agents,
    ports,
    wires,
    arrows,
    steps,
  };
}
