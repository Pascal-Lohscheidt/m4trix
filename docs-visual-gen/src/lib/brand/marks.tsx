import type { SVGProps } from 'react';
import { isoHex, type Pt, roundedPath, towards } from './geometry';

/**
 * m4trix logo concepts. Same grammar as the MCP mark: one stroke weight, round caps, constant
 * corner radius, a single color (`currentColor`), so every mark works in any one shade.
 * The m4trix twist is the angle: 30° isometric edges instead of 45°, from the cube logo.
 */

export interface MarkProps extends Omit<SVGProps<SVGSVGElement>, 'stroke'> {
  /** Rendered size in px (square). */
  size?: number;
  /** Stroke width on the 100-unit grid. Thicker reads better below 24 px. */
  weight?: number;
  /** Accessible name. Defaults to "m4trix"; pass `aria-hidden` next to a visible wordmark. */
  title?: string;
}

function MarkSvg({
  size = 96,
  weight = 7,
  title = 'm4trix',
  children,
  ...rest
}: MarkProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      {...rest}
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

const R = 40;
const CORNER = 7;

/** Face shades for `shades`: top lit, right mid, left in shadow. Opacity, so any one ink works. */
const SHADES = { top: 1, right: 0.68, left: 0.44 };

/**
 * The m4trix mark: a cube drawn as a pinwheel. Each visible face is one hooked stroke (two
 * outer edges, then in along the edge it shares with the next face), turned 120° from the
 * next. Three strokes like MCP's three, interlocking around an open center, so the cube also
 * reads as events circling through.
 *
 * `shades` gives each face its own opacity of the one ink (the cube lit from above), `node`
 * puts an agent dot where the hooks meet.
 */
export function PinwheelMark({
  gap = 13,
  shades = false,
  node = false,
  ...props
}: MarkProps & { gap?: number; shades?: boolean; node?: boolean }) {
  const h = isoHex(R);
  const faces: { pts: Pt[]; shade: number }[] = [
    { pts: [h.upperRight, h.top, h.upperLeft, h.center], shade: SHADES.top },
    { pts: [h.upperLeft, h.lowerLeft, h.bottom, h.center], shade: SHADES.left },
    { pts: [h.bottom, h.lowerRight, h.upperRight, h.center], shade: SHADES.right },
  ];
  const weight = props.weight ?? 7;
  return (
    <MarkSvg {...props}>
      {faces.map(({ pts: face, shade }) => {
        const pts = [...face];
        // Start just past the shared vertex, stop short of the center.
        pts[0] = towards(face[0], face[1], gap);
        pts[3] = towards(face[3], face[2], node ? gap * 1.15 : gap * 0.9);
        return (
          <path
            key={face[0].join()}
            d={roundedPath(pts, CORNER + 2)}
            strokeOpacity={shades ? shade : undefined}
          />
        );
      })}
      {node ? <circle cx={50} cy={50} r={weight * 0.72} fill="currentColor" stroke="none" /> : null}
    </MarkSvg>
  );
}

/**
 * B. Junction: the cube outline with its inner Y as three channels meeting at one agent
 * (the dot). The arms stop short of the node.
 */
export function JunctionMark({ gap = 11, ...props }: MarkProps & { gap?: number }) {
  const h = isoHex(R);
  const outline = [h.top, h.upperRight, h.lowerRight, h.bottom, h.lowerLeft, h.upperLeft];
  const arms = [h.upperLeft, h.upperRight, h.bottom];
  return (
    <MarkSvg {...props}>
      <path d={roundedPath(outline, CORNER, true)} />
      {arms.map((end) => {
        const from = towards(h.center, end, gap);
        return <path key={end.join()} d={`M${from[0]} ${from[1]}L${end[0]} ${end[1]}`} />;
      })}
      <circle cx={50} cy={50} r={(props.weight ?? 7) * 0.75} fill="currentColor" stroke="none" />
    </MarkSvg>
  );
}

type MarkComponent = (props: MarkProps) => React.JSX.Element;

export const MARKS: { id: string; name: string; Mark: MarkComponent }[] = [
  { id: 'pinwheel', name: 'Pinwheel', Mark: (p) => <PinwheelMark {...p} /> },
  { id: 'pinwheel-shades', name: 'Pinwheel, shades', Mark: (p) => <PinwheelMark shades {...p} /> },
  { id: 'pinwheel-node', name: 'Pinwheel, node', Mark: (p) => <PinwheelMark node {...p} /> },
  { id: 'junction', name: 'Junction (alt)', Mark: JunctionMark },
];

/**
 * App icon / favicon: the mark on a square tile, like MCP's. Self-contained SVG (no
 * currentColor), so it can be written straight to a file.
 *
 * `weight` is in tile units (the mark is scaled by `scale`). Small favicons want a larger
 * `scale` and `weight`; Apple touch icons want `radius={0}` (iOS rounds them itself).
 */
export function AppIcon({
  size = 180,
  tile = '#0b0b0e',
  ink = '#ffffff',
  weight = 6,
  scale = 0.66,
  radius = 22,
  gap,
}: {
  size?: number;
  tile?: string;
  ink?: string;
  weight?: number;
  scale?: number;
  radius?: number;
  /** Gap between the strokes, in mark units (see `PinwheelMark`). */
  gap?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
    >
      <title>m4trix</title>
      <rect width="100" height="100" rx={radius} fill={tile} />
      <g transform={`translate(50 50) scale(${scale}) translate(-50 -50)`} color={ink}>
        <PinwheelMark size={100} weight={weight / scale} gap={gap} aria-hidden />
      </g>
    </svg>
  );
}
