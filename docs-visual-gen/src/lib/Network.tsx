import { Graph } from '@phosphor-icons/react/dist/ssr';
import { type Box, boxStyle } from './geometry';
import { Tag } from './Tag';
import './network.css';

/** Frosted-glass boundary of an AgentNetwork. */
export function Network({ box, label = 'AgentNetwork' }: { box: Box; label?: string }) {
  return (
    <>
      <div className="dv-network" style={boxStyle(box)} />
      <Tag
        box={box}
        offset={30}
        name={label}
        ink="var(--dv-network-ink)"
        icon={<Graph size={16} weight="duotone" color="var(--dv-network-ink)" />}
      />
    </>
  );
}
