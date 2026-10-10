import type { CSSProperties, ReactNode } from 'react';
import type { Box } from './geometry';
import './tag.css';

export type TagEdge = 'top' | 'bottom';

/** Glass label pill that sits on a container's top or bottom border. */
export function Tag({
  box,
  edge = 'top',
  offset = 22,
  kind,
  name,
  icon,
  ink,
  className,
}: {
  box: Box;
  edge?: TagEdge;
  offset?: number;
  kind?: string;
  name: string;
  icon?: ReactNode;
  ink?: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `tag ${className}` : 'tag'}
      style={
        {
          position: 'absolute',
          left: box.x + offset,
          top: edge === 'top' ? box.y : box.y + box.h,
          transform: 'translateY(-50%)',
          '--tag-ink': ink,
        } as CSSProperties
      }
    >
      {icon}
      {kind && <span className="tag-kind">{kind}</span>}
      <span className="tag-name">{name}</span>
    </div>
  );
}
