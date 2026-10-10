import { type Box, boxStyle } from './geometry';
import { Tag, type TagEdge } from './Tag';
import './channel.css';

export type ChannelTone = 'sand' | 'rose' | 'mint';

/**
 * Tinted, dashed region. Agents placed where two channels overlap read as
 * "subscribes to one, publishes to the other".
 */
export function Channel({
  box,
  name,
  tone,
  labelEdge = 'top',
  labelOffset,
}: {
  box: Box;
  name: string;
  tone: ChannelTone;
  labelEdge?: TagEdge;
  labelOffset?: number;
}) {
  return (
    <>
      <div className={`channel tone-${tone}`} style={boxStyle(box)} />
      <Tag
        box={box}
        edge={labelEdge}
        offset={labelOffset}
        kind="channel"
        name={name}
        ink="var(--tone-ink)"
        className={`tone-${tone}`}
      />
    </>
  );
}
