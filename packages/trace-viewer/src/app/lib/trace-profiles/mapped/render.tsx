import { type ReactNode, useMemo, useState } from 'react';
import { JsonBlock } from '../../../components/mapped-views/JsonBlock';
import { MappedView } from '../../../components/mapped-views/MappedView';
import { PayloadSection } from '../../../components/PayloadSection';
import type { RunNode } from '../../../types';
import { resolveView } from '../../payload-mapper/extract';
import type { PayloadMapping } from '../../payload-mapper/mapping-schema';
import { type PayloadSide, selectRule } from '../../payload-mapper/match';
import { useMapperDialog } from '../../../state/mapper-dialog-context';
import { cx } from '../../viewer';
import type { ProfileRenderProps } from '../types';

type MappedPayloadProps = {
  mapping: PayloadMapping;
  run: RunNode;
  side: PayloadSide;
  data: unknown;
  /** When set (custom profile in the run detail), unmatched/partial payloads offer "Improve". */
  improve?: { profileId: string; refId: string };
};

function ImproveWithRunButton({ improve }: { improve: MappedPayloadProps['improve'] }): ReactNode {
  const mapper = useMapperDialog();
  if (!improve || !mapper) return null;
  return (
    <button
      type="button"
      onClick={() =>
        mapper.openMapper({
          mode: 'improve',
          profileId: improve.profileId,
          pinnedRefs: [improve.refId],
        })
      }
      className="rounded border border-violet-500/30 px-1.5 py-0.5 text-violet-300 transition-colors hover:bg-violet-500/15"
      title="Re-sample including this payload and ask the AI mapper to improve the profile"
    >
      ✦ Improve with this run
    </button>
  );
}

export function MappedPayload({
  mapping,
  run,
  side,
  data,
  improve,
}: MappedPayloadProps): ReactNode {
  const [showRaw, setShowRaw] = useState(false);
  const result = useMemo(() => {
    const rule = selectRule(mapping, { run, side, payload: data });
    return rule ? { rule, ...resolveView(rule.view, data) } : null;
  }, [mapping, run, side, data]);

  if (!result) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          No rule matched — showing raw JSON.
          <span className="ml-auto">
            <ImproveWithRunButton improve={improve} />
          </span>
        </div>
        <JsonBlock value={data} />
      </div>
    );
  }

  const { rule, view, issues } = result;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 font-mono text-violet-300"
          title={rule.description ?? `Matched rule "${rule.id}"`}
        >
          {rule.id}
        </span>
        {issues.length > 0 && (
          <>
            <span className="text-amber-400/80" title={issues.join('\n')}>
              {issues.length} unmatched path{issues.length === 1 ? '' : 's'}
            </span>
            <ImproveWithRunButton improve={improve} />
          </>
        )}
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className={cx(
            'ml-auto rounded px-1.5 py-0.5 transition-colors',
            showRaw
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
          )}
        >
          Raw JSON
        </button>
      </div>
      {showRaw ? <JsonBlock value={data} /> : <MappedView view={view} />}
    </div>
  );
}

export function renderMappedMetadata(
  mapping: PayloadMapping,
  { run }: ProfileRenderProps,
): ReactNode {
  if (!run.metadata || Object.keys(run.metadata).length === 0) return null;
  const meta = run.metadata;
  const picked = (mapping.metadata?.pick ?? [])
    .filter((key) => meta[key] != null && meta[key] !== '')
    .map((key) => [mapping.metadata?.labels?.[key] ?? key, String(meta[key])] as const);

  if (picked.length === 0) {
    return (
      <div className="mt-3">
        <div className="mb-1.5 font-semibold">Metadata</div>
        <JsonBlock value={meta} />
      </div>
    );
  }
  return (
    <div className="mt-3">
      <div className="mb-1.5 font-semibold">Metadata</div>
      <dl className="mb-2 grid gap-1 rounded-lg border border-violet-500/20 bg-violet-500/5 p-2 text-xs">
        {picked.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2">
            <dt className="truncate font-mono text-violet-300/90">{label}</dt>
            <dd className="m-0 break-all text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-300">
          Raw metadata JSON
        </summary>
        <div className="mt-2">
          <JsonBlock value={meta} />
        </div>
      </details>
    </div>
  );
}

export function renderMappedPayload(
  mapping: PayloadMapping,
  side: PayloadSide,
  props: ProfileRenderProps,
  profileId?: string,
): ReactNode {
  const { run, payloadCache, payloadLoading, onLoadPayload } = props;
  const refId = side === 'input' ? run.inputRef : run.outputRef;
  return (
    <PayloadSection
      label={side === 'input' ? 'Input' : 'Output'}
      refId={refId}
      payloadCache={payloadCache}
      loadingRef={payloadLoading}
      onLoad={onLoadPayload}
      renderLoaded={(data) => (
        <MappedPayload
          mapping={mapping}
          run={run}
          side={side}
          data={data}
          improve={profileId && refId ? { profileId, refId } : undefined}
        />
      )}
    />
  );
}
