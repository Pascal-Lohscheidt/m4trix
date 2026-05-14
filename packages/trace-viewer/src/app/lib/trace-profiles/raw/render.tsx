import type { ReactNode } from 'react';
import { PayloadSection } from '../../../components/PayloadSection';
import type { ProfileRenderProps } from '../types';

function JsonBlock({ value }: { value: unknown }): ReactNode {
  return (
    <pre className="m-0 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function renderRawMetadata({ run }: ProfileRenderProps): ReactNode {
  if (!run.metadata || Object.keys(run.metadata).length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1.5 font-semibold">Metadata</div>
      <JsonBlock value={run.metadata} />
    </div>
  );
}

export function renderRawInput(props: ProfileRenderProps): ReactNode {
  const { run, payloadCache, payloadLoading, onLoadPayload } = props;
  return (
    <PayloadSection
      label="Input"
      refId={run.inputRef}
      payloadCache={payloadCache}
      loadingRef={payloadLoading}
      onLoad={onLoadPayload}
      renderLoaded={(data) => <JsonBlock value={data} />}
    />
  );
}

export function renderRawOutput(props: ProfileRenderProps): ReactNode {
  const { run, payloadCache, payloadLoading, onLoadPayload } = props;
  return (
    <PayloadSection
      label="Output"
      refId={run.outputRef}
      payloadCache={payloadCache}
      loadingRef={payloadLoading}
      onLoad={onLoadPayload}
      renderLoaded={(data) => <JsonBlock value={data} />}
    />
  );
}
