import type { ReactNode } from 'react';
import type { MappingDiff } from '../../lib/payload-mapper/rule-diff';
import { cx } from '../../lib/viewer';
import { JsonBlock } from '../mapped-views/JsonBlock';

const BADGE: Record<string, string> = {
  added: 'bg-emerald-500/15 text-emerald-300',
  changed: 'bg-amber-500/15 text-amber-300',
  removed: 'bg-red-500/15 text-red-300',
  unchanged: 'bg-white/[0.07] text-zinc-500',
};

export function RuleDiffList({ diff }: { diff: MappingDiff }): ReactNode {
  const changed = diff.rules.filter((r) => r.type !== 'unchanged' || r.moved);
  return (
    <div className="space-y-1.5">
      {changed.length === 0 && !diff.metadataChanged && !diff.usageChanged && (
        <div className="text-[11px] text-zinc-500">No rule changes.</div>
      )}
      {changed.map((change) => (
        <details
          key={`${change.type}-${change.id}`}
          className="rounded-lg border border-white/[0.07] bg-white/[0.04] px-2 py-1"
        >
          <summary className="flex cursor-pointer items-center gap-2 text-xs">
            <span
              className={cx('rounded-md px-1.5 py-0.5 text-[10px] uppercase', BADGE[change.type])}
            >
              {change.type}
            </span>
            <span className="font-mono text-zinc-200">{change.id}</span>
            {'moved' in change && change.moved && (
              <span className="text-[10px] text-zinc-500">reordered</span>
            )}
          </summary>
          <div className="mt-1.5">
            {change.type === 'changed' ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 text-[10px] uppercase text-zinc-500">Before</div>
                  <JsonBlock value={change.before} className="max-h-60 text-[10px]" />
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase text-zinc-500">After</div>
                  <JsonBlock value={change.after} className="max-h-60 text-[10px]" />
                </div>
              </div>
            ) : change.type === 'added' ? (
              <JsonBlock value={change.after} className="max-h-60 text-[10px]" />
            ) : change.type === 'removed' ? (
              <JsonBlock value={change.before} className="max-h-60 text-[10px]" />
            ) : (
              <div className="text-[11px] text-zinc-500">
                Same rule, new position (first match wins).
              </div>
            )}
          </div>
        </details>
      ))}
      {(diff.metadataChanged || diff.usageChanged) && (
        <div className="text-[11px] text-zinc-400">
          {[diff.metadataChanged && 'metadata keys', diff.usageChanged && 'usage rules']
            .filter(Boolean)
            .join(' and ')}{' '}
          changed.
        </div>
      )}
    </div>
  );
}
