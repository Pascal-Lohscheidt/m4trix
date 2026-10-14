/**
 * Geometry for the brand marks. Everything is drawn on a 100 × 100 grid around an isometric
 * hexagon (the outline of a cube seen from above): pointy top, 30° edges.
 */

export type Pt = readonly [number, number];

export const CENTER: Pt = [50, 50];

/** Isometric hexagon of circumradius `r` around the center. */
export function isoHex(r: number) {
  const dx = r * Math.cos(Math.PI / 6);
  const dy = r / 2;
  const [cx, cy] = CENTER;
  return {
    top: [cx, cy - r] as Pt,
    upperRight: [cx + dx, cy - dy] as Pt,
    lowerRight: [cx + dx, cy + dy] as Pt,
    bottom: [cx, cy + r] as Pt,
    lowerLeft: [cx - dx, cy + dy] as Pt,
    upperLeft: [cx - dx, cy - dy] as Pt,
    center: CENTER,
  };
}

export const lerp = (a: Pt, b: Pt, t: number): Pt => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Point `d` units from `a` towards `b`. */
export function towards(a: Pt, b: Pt, d: number): Pt {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return lerp(a, b, d / len);
}

const f = (n: number) => Number(n.toFixed(3));

/**
 * SVG path through `points` with every inner corner rounded to radius `r` (clamped so two
 * neighbouring corners never overlap). Pass `closed` for a loop.
 */
export function roundedPath(points: readonly Pt[], r: number, closed = false): string {
  const n = points.length;
  if (n < 2) return '';
  const at = (i: number) => points[(i + n) % n];
  const corners = closed ? n : n - 2;
  const parts: string[] = [];
  let start: Pt | undefined;

  for (let k = 0; k < corners; k++) {
    const i = closed ? k : k + 1;
    const prev = at(i - 1);
    const p = at(i);
    const next = at(i + 1);
    const a = [prev[0] - p[0], prev[1] - p[1]];
    const b = [next[0] - p[0], next[1] - p[1]];
    const la = Math.hypot(a[0], a[1]);
    const lb = Math.hypot(b[0], b[1]);
    const angle = Math.acos((a[0] * b[0] + a[1] * b[1]) / (la * lb));
    // Distance from the corner to where the arc meets each edge.
    const cut = Math.min(r / Math.tan(angle / 2), la / 2, lb / 2);
    const radius = cut * Math.tan(angle / 2);
    const p1: Pt = towards(p, prev, cut);
    const p2: Pt = towards(p, next, cut);
    const sweep = a[0] * b[1] - a[1] * b[0] < 0 ? 1 : 0;
    if (!start) {
      start = closed ? p1 : points[0];
      parts.push(`M${f(start[0])} ${f(start[1])}`);
    }
    parts.push(`L${f(p1[0])} ${f(p1[1])}`);
    parts.push(`A${f(radius)} ${f(radius)} 0 0 ${sweep} ${f(p2[0])} ${f(p2[1])}`);
  }

  if (!start) {
    return `M${f(points[0][0])} ${f(points[0][1])}L${f(points[1][0])} ${f(points[1][1])}`;
  }
  if (closed) parts.push('Z');
  else parts.push(`L${f(points[n - 1][0])} ${f(points[n - 1][1])}`);
  return parts.join('');
}
