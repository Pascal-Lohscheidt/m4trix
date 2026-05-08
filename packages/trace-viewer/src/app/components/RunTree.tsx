import { cx, statusTextClass } from '../lib/viewer';
import type { RunNode } from '../types';

type RunTreeProps = {
  node: RunNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function RunTree(props: RunTreeProps): React.ReactNode {
  const { node, selectedId, onSelect } = props;
  const selected = node.runId === selectedId;

  return (
    <div key={node.runId}>
      <button
        type="button"
        onClick={() => onSelect(node.runId)}
        className={cx(
          'mb-1 block w-full rounded-md border px-2.5 py-1.5 text-left text-[13px] text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800',
          selected
            ? 'border-amber-400 bg-zinc-800 shadow-[0_0_0_1px_rgba(251,191,36,0.15)]'
            : 'border-zinc-700 bg-zinc-900',
        )}
      >
        <span className="mr-2 text-zinc-400">{node.type}</span>
        {node.name}
        <span className={cx('ml-2 text-xs', statusTextClass(node.status))}>{node.status}</span>
      </button>
      {node.children.length > 0 && (
        <div className="ml-4 border-l border-zinc-800 pl-3">
          {node.children.map((child) => (
            <RunTree key={child.runId} node={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
