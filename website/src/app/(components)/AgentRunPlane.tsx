'use client';

import {
  BrowserIcon,
  FunnelIcon,
  type Icon,
  ListMagnifyingGlassIcon,
  RobotIcon,
  WrenchIcon,
} from '@phosphor-icons/react';
import { GLOW_MIN, reqIndex, type Run, type RunEvent, TRAVEL, visualTimes } from '@/lib/agent-run';

/**
 * The event plane of the recorded run. Channels are rails (one PubSub each), agents are cards
 * plugged into the rails they subscribe or publish to. A packet runs down its emitter's wire, along
 * the channel and up to each receiver. Everything is placed in percent and driven by the replay
 * clock (--t on an ancestor), so no React render happens per frame.
 */

type Pt = { x: number; y: number };

const RAILS: Record<string, { y: number; from: number; label: string }> = {
  main: { y: 13, from: 9, label: 'main' },
  work: { y: 50, from: 19, label: 'work' },
  client: { y: 87, from: 9, label: 'client · sse' },
};
const RAIL_END = 98.5;

type Kind = 'browser' | 'agent' | 'aggregator' | 'catch-all';

const NODES: Record<string, Pt & { kind: Kind; detail?: string; subs: string[]; pubs: string[] }> =
  {
    you: { x: 9, y: 50, kind: 'browser', subs: ['client'], pubs: ['main'] },
    triage: { x: 25, y: 31.5, kind: 'agent', subs: ['main'], pubs: ['work', 'client'] },
    findings: { x: 46, y: 31.5, kind: 'aggregator', subs: ['work'], pubs: ['work'] },
    auditLog: { x: 88, y: 31.5, kind: 'catch-all', subs: ['main', 'work', 'client'], pubs: [] },
    logs: {
      x: 36,
      y: 68.5,
      kind: 'agent',
      detail: 'searchLogs',
      subs: ['work'],
      pubs: ['work', 'client'],
    },
    metrics: {
      x: 56,
      y: 68.5,
      kind: 'agent',
      detail: 'queryMetrics',
      subs: ['work'],
      pubs: ['work', 'client'],
    },
    deploys: {
      x: 77.5,
      y: 68.5,
      kind: 'agent',
      detail: 'diffDeploy',
      subs: ['work'],
      pubs: ['work', 'client'],
    },
    remediator: {
      x: 67,
      y: 31.5,
      kind: 'agent',
      detail: 'rollbackDeploy',
      subs: ['work'],
      pubs: ['client'],
    },
  };

const KIND_ICON: Record<Kind, Icon> = {
  browser: BrowserIcon,
  agent: RobotIcon,
  aggregator: FunnelIcon,
  'catch-all': ListMagnifyingGlassIcon,
};

type Window = { key: string; s: number; e: number };
type Segment = { key: string; a: Pt; b: Pt; s: number; d: number; approval: boolean };

/** Overlapping windows would stack their translucent fills into a solid block. */
function merge(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a.s - b.s);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.s <= last.e + 40) last.e = Math.max(last.e, w.e);
    else out.push({ ...w });
  }
  return out;
}

function vars(values: Record<string, number>): React.CSSProperties {
  return values as unknown as React.CSSProperties;
}

/** Emitter, down or up to the rail, along it, then to the receiver. Time split by distance. */
function route(key: string, from: Pt, rail: number, to: Pt, start: number, approval: boolean) {
  const pts = [from, { x: from.x, y: rail }, { x: to.x, y: rail }, to];
  // Percent of a roughly 600 x 290 px plane, so vertical and horizontal travel read the same.
  const len = (a: Pt, b: Pt) => Math.hypot((b.x - a.x) * 6, (b.y - a.y) * 2.9);
  const lengths = pts.slice(1).map((p, i) => len(pts[i], p));
  const total = lengths.reduce((sum, l) => sum + l, 0) || 1;
  const segments: Segment[] = [];
  let s = start;
  lengths.forEach((l, i) => {
    const d = (l / total) * TRAVEL;
    if (d > 0.5) segments.push({ key: `${key}-${i}`, a: pts[i], b: pts[i + 1], s, d, approval });
    s += d;
  });
  return segments;
}

export default function AgentRunPlane({
  run,
  decided,
  onSelect,
}: {
  run: Run;
  decided: boolean;
  onSelect: (id: string) => void;
}) {
  const { event: vt, arrive } = visualTimes(run);
  const segments: Segment[] = [];
  const railFlashes: Record<string, Window[]> = { main: [], work: [], client: [] };
  const glows: Record<string, Window[]> = {};
  const glow = (id: string, w: Window) => {
    glows[id] ??= [];
    glows[id].push(w);
  };
  const approval = (e: RunEvent) => e.name.startsWith('approval');

  for (const e of run.events) {
    const at = vt[e.i];
    for (const channel of e.channels) {
      railFlashes[channel]?.push({ key: `r${e.i}`, s: at + TRAVEL * 0.2, e: at + TRAVEL });
    }
    const from = NODES[e.by];
    if (from && e.channels.includes('client')) {
      segments.push(...route(`b${e.i}`, from, RAILS.client.y, NODES.you, at, approval(e)));
      glow('you', { key: `in${e.i}`, s: at + TRAVEL, e: at + TRAVEL + GLOW_MIN });
    }
    if (e.by === 'you') glow('you', { key: `out${e.i}`, s: at, e: at + GLOW_MIN });
  }

  for (const inv of run.invocations) {
    const trigger = run.events[inv.trigger];
    const from = trigger && NODES[trigger.by];
    const to = NODES[inv.lane];
    const rail = RAILS[inv.channel];
    const start = arrive.get(inv);
    if (!trigger || !from || !to || !rail || start === undefined) continue;
    segments.push(
      ...route(
        `d${inv.trigger}-${inv.lane}-${inv.channel}`,
        from,
        rail.y,
        to,
        vt[inv.trigger],
        approval(trigger),
      ),
    );
    const lastEmit = Math.max(
      0,
      ...run.events
        .filter((e) => e.by === inv.lane && e.t >= inv.start && e.t <= inv.end + 2)
        .map((e) => vt[e.i]),
    );
    glow(inv.lane, {
      key: `g${inv.trigger}-${inv.channel}-${inv.start}`,
      s: start,
      e: Math.max(start + GLOW_MIN, inv.end, lastEmit + 120),
    });
  }

  // A model call cannot start on screen before its agent's trigger arrived.
  const thinking = run.spans.map((span) => {
    const inv = run.invocations.find(
      (i) => i.lane === span.lane && i.start <= span.start && span.start <= i.end,
    );
    const s = Math.max(span.start, (inv && arrive.get(inv)) ?? 0);
    return { ...span, s, e: Math.max(span.end, s + 150) };
  });

  const req = reqIndex(run);
  const resolved = run.events.find((e) => e.name === 'approval-resolved');
  const awaitTo = decided && resolved ? vt[resolved.i] : 1e9;
  const waiting: Record<string, Window> = {
    remediator: { key: 'wait-r', s: vt[req], e: awaitTo },
    you: { key: 'wait-y', s: vt[req] + TRAVEL, e: awaitTo },
  };

  return (
    <div className="relative h-full min-w-[37rem]">
      {Object.entries(RAILS).map(([id, rail]) => (
        <div key={id}>
          <div
            className="plane-rail"
            style={{ left: `${rail.from}%`, width: `${RAIL_END - rail.from}%`, top: `${rail.y}%` }}
          >
            {merge(railFlashes[id]).map((w) => (
              <span
                key={w.key}
                className="plane-rail-flash"
                style={vars({ '--s': w.s, '--e': w.e })}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => onSelect(id)}
            aria-label={`${id} channel, show code`}
            className="plane-rail-label"
            style={{ left: `${rail.from + (id === 'work' ? 0 : 2)}%`, top: `${rail.y}%` }}
          >
            {rail.label}
          </button>
        </div>
      ))}

      {Object.entries(NODES).map(([id, node]) => {
        const ys = [...node.subs, ...node.pubs].map((c) => RAILS[c].y);
        const top = Math.min(node.y, ...ys);
        const bottom = Math.max(node.y, ...ys);
        return (
          <span
            key={`stub-${id}`}
            className="plane-stub"
            style={{ left: `${node.x}%`, top: `${top}%`, height: `${bottom - top}%` }}
          />
        );
      })}

      {Object.entries(NODES).flatMap(([id, node]) =>
        Object.keys(RAILS)
          .filter((c) => node.subs.includes(c) || node.pubs.includes(c))
          .map((c) => (
            <span
              key={`plug-${id}-${c}`}
              className={node.subs.includes(c) ? 'plane-plug plane-plug-sub' : 'plane-plug'}
              title={`${id} ${node.subs.includes(c) ? 'subscribes to' : 'publishes to'} ${c}`}
              style={{ left: `${node.x}%`, top: `${RAILS[c].y}%` }}
            />
          )),
      )}

      {segments.map((seg) => (
        <span
          key={seg.key}
          className={`plane-packet ${seg.approval ? 'plane-packet-approval' : ''}`}
          style={vars({
            '--ax': seg.a.x,
            '--ay': seg.a.y,
            '--bx': seg.b.x,
            '--by': seg.b.y,
            '--s': seg.s,
            '--d': seg.d,
          })}
        />
      ))}

      {Object.entries(NODES).map(([id, node]) => {
        const KindIcon = KIND_ICON[node.kind];
        const wait = waiting[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-label={`${id}, show code`}
            className={`plane-node ${node.kind === 'browser' ? 'plane-node-outside' : ''}`}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            {merge(glows[id] ?? []).map((w) => (
              <span key={w.key} className="plane-glow" style={vars({ '--s': w.s, '--e': w.e })} />
            ))}
            {wait && req >= 0 ? (
              <span
                className="plane-glow plane-glow-wait"
                style={vars({ '--s': wait.s, '--e': wait.e })}
              />
            ) : null}
            {thinking
              .filter((span) => span.lane === id)
              .map((span) => (
                <span
                  key={`${span.name}-${span.start}`}
                  className="plane-llm"
                  style={vars({ '--s': span.s, '--e': span.e })}
                >
                  thinking
                </span>
              ))}
            <span className="relative truncate text-[11.5px] text-text-1">{id}</span>
            <span className="relative flex min-w-0 items-center gap-1 text-[9px] text-text-4">
              {node.detail ? (
                <WrenchIcon aria-hidden className="h-2.5 w-2.5 shrink-0" />
              ) : (
                <KindIcon aria-hidden className="h-2.5 w-2.5 shrink-0" />
              )}
              <span className="truncate">{node.detail ?? node.kind}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
