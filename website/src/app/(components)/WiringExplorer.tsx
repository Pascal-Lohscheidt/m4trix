'use client';

import { CheckIcon, PlusIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import CodeBlock from './CodeBlock';

type Extra = { id: string; file: string; does: string; line: string };

const EXTRAS: Extra[] = [
  {
    id: 'pager',
    file: 'pager.ts',
    does: 'pages on-call when the first finding lands',
    line: '    registerAgent(pager).subscribe(work)',
  },
  {
    id: 'postmortem',
    file: 'postmortem.ts',
    does: 'drafts a postmortem once the answer has streamed',
    line: '    registerAgent(postmortem).subscribe(client).publishTo(client)',
  },
  {
    id: 'costMeter',
    file: 'cost-meter.ts',
    does: 'tallies model spend per run',
    line: '    registerAgent(costMeter).subscribe(mainChannel).subscribe(work)',
  },
];

// The incident-triage network from the replay at the top of the page.
const HEAD = `export const network = AgentNetwork.setup(
  ({ mainChannel, createChannel, proxy, registerAgent, registerAggregator }) => {
    const work = createChannel('work')
    const client = createChannel('client').proxy(proxy.sse())

    registerAgent(triage).subscribe(mainChannel).publishTo(work).publishTo(client)
    for (const agent of [logs, metrics, deploys]) {
      registerAgent(agent).subscribe(work).publishTo(work).publishTo(client)
    }
    registerAggregator(findings).subscribe(work).publishTo(work)
    registerAgent(remediator).subscribe(work).publishTo(client)`;

const TAIL = `  },
)`;

const HEAD_LINES = HEAD.split('\n').length;

function FileRow({
  name,
  status,
  tone,
}: {
  name: string;
  status: string;
  tone: 'same' | 'new' | 'edit';
}) {
  const color =
    tone === 'same' ? 'text-text-3' : tone === 'new' ? 'text-success' : 'text-(--accent-text)';
  return (
    <li className="flex items-baseline justify-between gap-3 py-2 font-mono text-[12.5px]">
      <span className="truncate text-text-1">{name}</span>
      <span className={`shrink-0 text-[11.5px] ${color}`}>{status}</span>
    </li>
  );
}

export default function WiringExplorer() {
  const [on, setOn] = useState<string[]>(['pager']);
  const active = EXTRAS.filter((extra) => on.includes(extra.id));
  const code = [HEAD, ...active.map((extra) => extra.line), TAIL].join('\n');
  const toggle = (id: string) =>
    setOn((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Agents to add</legend>
        {EXTRAS.map((extra) => {
          const pressed = on.includes(extra.id);
          return (
            <button
              key={extra.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => toggle(extra.id)}
              className={`wire-toggle ${pressed ? 'wire-toggle-on' : ''}`}
            >
              {pressed ? (
                <CheckIcon aria-hidden className="h-3.5 w-3.5" weight="bold" />
              ) : (
                <PlusIcon aria-hidden className="h-3.5 w-3.5" weight="bold" />
              )}
              {extra.id}
            </button>
          );
        })}
      </fieldset>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <CodeBlock
          className="agent-code-block min-w-0"
          code={code}
          language="typescript"
          filename="network.ts"
          lineClassName={(line) =>
            line > HEAD_LINES && line <= HEAD_LINES + active.length ? 'code-line-added' : ''
          }
        />
        <div className="gfx-card self-start">
          <p className="gfx-head">What changed</p>
          <ul className="divide-y divide-(--border) px-4">
            <FileRow name="triage.ts" status="unchanged" tone="same" />
            <FileRow name="investigators.ts" status="unchanged" tone="same" />
            <FileRow name="remediator.ts" status="unchanged" tone="same" />
            <FileRow
              name="network.ts"
              status={
                active.length
                  ? `+${active.length} line${active.length > 1 ? 's' : ''}`
                  : 'unchanged'
              }
              tone={active.length ? 'edit' : 'same'}
            />
            {active.map((extra) => (
              <FileRow key={extra.id} name={extra.file} status="new file" tone="new" />
            ))}
          </ul>
          {active.length ? (
            <ul className="border-t border-(--border) px-4 py-3 text-[13px] leading-relaxed text-text-2">
              {active.map((extra) => (
                <li key={extra.id}>
                  <span className="font-mono text-[12px] text-text-1">{extra.id}</span> {extra.does}
                  .
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-(--border) px-4 py-3 text-[13px] leading-relaxed text-text-3">
              Toggle an agent above to wire it in.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
