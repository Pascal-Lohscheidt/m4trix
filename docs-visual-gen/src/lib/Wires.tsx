import './wires.css';

/** Dashed connector paths (SVG path data in canvas coordinates). */
export function Wires({ paths }: { paths: string[] }) {
  return (
    <svg className="dv-wires" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} className="dv-wire" d={d} />
      ))}
    </svg>
  );
}
