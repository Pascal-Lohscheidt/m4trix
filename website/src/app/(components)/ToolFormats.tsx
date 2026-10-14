'use client';

import { useState } from 'react';
import CodeBlock from './CodeBlock';

type Format = { id: string; label: string; code: string; note: string };

// The assistant's tools from the anatomy above, handed to three model SDKs.
const FORMATS: Format[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    code: `import OpenAI from 'openai'

const openai = new OpenAI()

// In the assistant's logic: async ({ triggerEvent, tools, signal }) => { ... }
const completion = await openai.chat.completions.create(
  {
    model,
    messages: [{ role: 'user', content: triggerEvent.payload.text }],
    tools: tools.toOpenAI(),
  },
  { signal },
)`,
    note: 'Your loop runs the calls: executeForModel turns each result or error into a tool message.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    code: `import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

// In the assistant's logic: async ({ triggerEvent, tools, signal }) => { ... }
const message = await anthropic.messages.create(
  {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: triggerEvent.payload.text }],
    tools: tools.toAnthropic(),
  },
  { signal },
)`,
    note: 'Your loop runs the calls: executeForModel turns each result or error into a tool_result.',
  },
  {
    id: 'ai-sdk',
    label: 'AI SDK',
    code: `import { generateText, jsonSchema, stepCountIs } from 'ai'

// In the assistant's logic: async ({ triggerEvent, tools, signal }) => { ... }
const { text } = await generateText({
  model,
  prompt: triggerEvent.payload.text,
  tools: tools.toAiSdk({ jsonSchema }),
  stopWhen: stepCountIs(5),
  abortSignal: signal,
})`,
    note: 'The SDK runs the loop and the tools. A tool that fails reports a typed error to the model.',
  },
];

export default function ToolFormats() {
  const [active, setActive] = useState(FORMATS[0].id);
  const format = FORMATS.find((f) => f.id === active) ?? FORMATS[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-10">
      <div className="min-w-0 lg:px-4">
        <h3 className="bento-title">The same tools, for any model SDK</h3>
        <p className="bento-body max-w-[44ch]">
          Each tool&apos;s input schema becomes JSON Schema. The collection formats itself for the
          SDK you call, so tool definitions are written once.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Model SDK">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={f.id === active}
              onClick={() => setActive(f.id)}
              className={`run-tab ${f.id === active ? 'run-tab-active' : ''}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <CodeBlock
          className="agent-code-block min-w-0"
          code={format.code}
          language="typescript"
          filename="assistant.ts"
        />
        <p className="text-[13px] text-text-3">{format.note}</p>
      </div>
    </div>
  );
}
