'use client';

import { useState } from 'react';
import CodeBlock from './CodeBlock';

const AGENT_CODE = `const Message = AgentNetworkEvent.of('message', S.Struct({
  role: S.Literal('user', 'assistant'),
  text: S.String,
}))
const Chunk = AgentNetworkEvent.of('chunk', S.Struct({ delta: S.String }))

export const assistant = AgentFactory.run()
  .listensTo([Message])
  .emits([Message, Chunk])
  .tools(webSearch, askResearcher)
  .logic(async ({ triggerEvent, emit, contextEvents, tools }) => {
    if (triggerEvent.payload.role !== 'user') return
    const history = contextEvents.all.filter(Message.is)

    const reply = await streamReply({
      history,
      tools: tools.toTools(),
      onToken: (delta) => emit(Chunk.make({ delta })),
    })

    emit(Message.make({ role: 'assistant', text: reply }))
  })
  .produce({})`;

type Part = { id: string; label: string; body: string; lines: number[] };

const PARTS: Part[] = [
  {
    id: 'events',
    label: 'Events',
    body: 'A name and an Effect Schema. Payloads are validated at runtime and inferred at compile time.',
    lines: [1, 2, 3, 4, 5],
  },
  {
    id: 'listens',
    label: '.listensTo',
    body: 'The agent runs only for these events. triggerEvent is typed from this list, so role is "user" | "assistant".',
    lines: [8, 12],
  },
  {
    id: 'emits',
    label: '.emits',
    body: 'emit accepts these events and nothing else. Emitting an undeclared event is a type error, and .make() checks the payload.',
    lines: [9, 18, 21],
  },
  {
    id: 'tools',
    label: '.tools',
    body: 'Tools declare schema input and output plus their dependencies. They can emit events of their own.',
    lines: [10, 17],
  },
  {
    id: 'memory',
    label: 'contextEvents',
    body: 'Every event in this conversation, in order. Chat history is a filter over the log, not a second store.',
    lines: [13, 16],
  },
];

export default function AgentAnatomy() {
  const [active, setActive] = useState(PARTS[1].id);
  const part = PARTS.find((p) => p.id === active) ?? PARTS[0];
  const lit = new Set(part.lines);

  return (
    <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-10">
      <ul className="flex flex-col gap-1" aria-label="Parts of an agent">
        {PARTS.map((p) => {
          const isActive = p.id === active;
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => setActive(p.id)}
                onMouseEnter={() => setActive(p.id)}
                onFocus={() => setActive(p.id)}
                className={`anatomy-item ${isActive ? 'anatomy-item-active' : ''}`}
              >
                <span className="font-mono text-[13px] font-medium">{p.label}</span>
                <span className="anatomy-body">{p.body}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <CodeBlock
        className="agent-code-block anatomy-code min-w-0 self-start"
        code={AGENT_CODE}
        language="typescript"
        filename="assistant.ts"
        lineClassName={(line) => (lit.has(line) ? 'code-line-lit' : 'code-line-dim')}
      />
    </div>
  );
}
