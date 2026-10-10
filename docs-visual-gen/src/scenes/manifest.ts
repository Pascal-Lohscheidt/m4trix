// Pure scene metadata. Shared by the browser app and the Node render script,
// so it must not import React, CSS, or anything browser-only.

export type SceneOutput =
  | { kind: 'png'; scale: number }
  | { kind: 'gif'; fps: number; durationMs: number; posterAtMs: number };

export interface SceneMeta {
  id: string;
  title: string;
  /** Docs page the visual was designed for (relative to /docs). */
  doc: string;
  width: number;
  height: number;
  output: SceneOutput;
}

export const sceneManifest: SceneMeta[] = [
  {
    id: 'network-anatomy',
    title: 'Network anatomy',
    doc: 'concepts/networks.md',
    width: 1400,
    height: 880,
    output: { kind: 'png', scale: 2 },
  },
  {
    id: 'request-flow',
    title: 'Request flow',
    doc: 'getting-started/whats-happening.md',
    width: 1360,
    height: 620,
    output: { kind: 'gif', fps: 25, durationMs: 7600, posterAtMs: 5250 },
  },
  {
    id: 'fan-out',
    title: 'Fan-out',
    doc: 'concepts/networks.md',
    width: 1360,
    height: 560,
    output: { kind: 'gif', fps: 25, durationMs: 5600, posterAtMs: 3420 },
  },
];

export function findScene(id: string): SceneMeta | undefined {
  return sceneManifest.find((scene) => scene.id === id);
}
