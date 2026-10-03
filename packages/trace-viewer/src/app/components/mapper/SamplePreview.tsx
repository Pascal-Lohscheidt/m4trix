import { type ReactNode, useMemo, useState } from 'react';
import type { CoverageReport } from '../../lib/payload-mapper/coverage';
import type { PayloadMapping } from '../../lib/payload-mapper/mapping-schema';
import type { Sample, SampleGroup } from '../../lib/payload-mapper/sampling';
import { MappedPayload } from '../../lib/trace-profiles/mapped/render';
import { cx } from '../../lib/viewer';
import type { RunNode } from '../../types';
import { JsonBlock } from '../mapped-views/JsonBlock';
import { GroupStatus } from './CoverageSummary';

function runFor(group: SampleGroup, sample: Sample): RunNode {
  return {
    runId: sample.runId,
    name: group.runName,
    type: group.runType,
    status: 'success',
    startTime: '',
    metadata: sample.runMetadata,
    children: [],
  };
}

type SamplePreviewProps = {
  groups: SampleGroup[];
  after: PayloadMapping;
  afterCoverage: CoverageReport;
  /** Improve mode: render the previous mapping on the left instead of raw JSON. */
  before?: PayloadMapping;
  beforeCoverage?: CoverageReport;
};

/** Group list + before/after rendering of each sampled payload. */
export function SamplePreview({
  groups,
  after,
  afterCoverage,
  before,
  beforeCoverage,
}: SamplePreviewProps): ReactNode {
  const [groupIndex, setGroupIndex] = useState(0);
  const [sampleIndex, setSampleIndex] = useState(0);
  const afterByKey = useMemo(
    () => new Map(afterCoverage.groups.map((g) => [g.key, g])),
    [afterCoverage],
  );
  const beforeByKey = useMemo(
    () => new Map((beforeCoverage?.groups ?? []).map((g) => [g.key, g])),
    [beforeCoverage],
  );

  const group = groups[Math.min(groupIndex, groups.length - 1)];
  if (!group) return <div className="text-xs text-zinc-500">No samples.</div>;
  const sample = group.samples[Math.min(sampleIndex, group.samples.length - 1)];
  const run = runFor(group, sample);

  return (
    <div className="grid min-h-0 grid-cols-[14rem_minmax(0,1fr)] gap-3">
      <ul className="m-0 max-h-[50vh] list-none space-y-0.5 overflow-auto p-0">
        {groups.map((g, i) => (
          <li key={g.key}>
            <button
              type="button"
              onClick={() => {
                setGroupIndex(i);
                setSampleIndex(0);
              }}
              className={cx(
                'flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11px]',
                i === groupIndex
                  ? 'bg-white/[0.07] text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900',
              )}
            >
              <span className="min-w-0 flex-1 truncate" title={g.key}>
                <span className="text-zinc-500">{g.runType}</span> {g.runName}{' '}
                <span className="text-zinc-600">{g.side}</span>
              </span>
              {before && <GroupStatus group={beforeByKey.get(g.key)} />}
              <GroupStatus group={afterByKey.get(g.key)} />
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-1">
          {group.samples.map((s, i) => (
            <button
              key={s.ref}
              type="button"
              onClick={() => setSampleIndex(i)}
              className={cx(
                'rounded-md px-2 py-0.5 text-[11px]',
                i === sampleIndex
                  ? 'bg-violet-500/20 text-violet-200'
                  : 'text-zinc-500 hover:bg-white/[0.08]',
              )}
            >
              Sample {i + 1}
            </button>
          ))}
          <code className="ml-auto truncate text-[10px] text-zinc-600">{sample.runId}</code>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
              {before ? 'Current version' : 'Raw (today)'}
            </div>
            <div className="max-h-[45vh] overflow-auto rounded-xl border border-white/[0.07] bg-black/25 p-2">
              {before ? (
                <MappedPayload
                  mapping={before}
                  run={run}
                  side={group.side}
                  data={sample.original}
                />
              ) : (
                <JsonBlock value={sample.original} className="max-h-none border-0 p-0" />
              )}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-violet-300/80">
              New mapping
            </div>
            <div className="max-h-[45vh] overflow-auto rounded-xl border border-violet-500/30 bg-black/25 p-2">
              <MappedPayload mapping={after} run={run} side={group.side} data={sample.original} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
