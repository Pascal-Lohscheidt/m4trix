import { Graph } from '@phosphor-icons/react';
import { type Box, boxStyle } from './geometry';
import { Tag } from './Tag';
import './network.css';

/** Frosted-glass boundary of an AgentNetwork. */
export function Network({ box }: { box: Box }) {
  return (
    <>
      <div className="network" style={boxStyle(box)} />
      <Tag
        box={box}
        offset={30}
        name="AgentNetwork"
        ink="var(--network-ink)"
        icon={<Graph size={16} weight="duotone" color="var(--network-ink)" />}
      />
    </>
  );
}
