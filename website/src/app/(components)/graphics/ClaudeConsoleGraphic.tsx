'use client';

import { createTimeline, onScroll, stagger, utils } from 'animejs';
import { useRef } from 'react';
import { siClaude } from 'simple-icons';
import { BrandIcon } from '@/components/BrandIcon';
import { useAnimeScope } from './useAnimeScope';

type Tone = 'text' | 'dim' | 'accent' | 'red' | 'amber' | 'green' | 'bold';
type Segment = [text: string, tone?: Tone] | [text: string, tone: Tone, flag: true];
type Line = Segment[];

const TONE: Record<Tone, React.CSSProperties> = {
  text: { color: 'var(--text-2)' },
  dim: { color: 'var(--text-3)' },
  accent: { color: 'var(--accent)' },
  red: { color: 'var(--red)' },
  amber: { color: 'var(--amber)' },
  green: { color: 'var(--green)' },
  bold: { color: 'var(--text-1)', fontWeight: 600 },
};

const PROMPT = 'why did the last support-agent run fail?';

/** MCP calls Claude Code makes while investigating; each shows a pending bullet, then its result. */
const TOOL_CALLS: { call: Line; result: Line }[] = [
  {
    call: [
      ['analyze_trace', 'bold'],
      [' (MCP)', 'dim'],
      ['(traceId: "latest")', 'text'],
    ],
    result: [['2 error runs, 1 root cause, 1 unfinished run', 'text']],
  },
  {
    call: [
      ['get_trace', 'bold'],
      [' (MCP)', 'dim'],
      ['(traceId: "aaaa1111")', 'text'],
    ],
    result: [['6 runs shown, 1 hidden', 'text']],
  },
  {
    call: [
      ['search_payloads', 'bold'],
      [' (MCP)', 'dim'],
      ['(query: "cache miss")', 'text'],
    ],
    result: [['1 distinct value, 3 occurrences in cache_get', 'text']],
  },
  {
    call: [
      ['get_conversation', 'bold'],
      [' (MCP)', 'dim'],
      ['(runId: "a-llm")', 'text'],
    ],
    result: [['2 messages, 1 tool call to lookup_order', 'text']],
  },
];

/** One run-tree row; columns are padded so the ASCII outline stays aligned. */
function treeRow(
  branch: string,
  name: string,
  latency: string,
  status: [string, Tone],
  detail: [string, Tone],
  flag?: [string, Tone],
): Line {
  const nameTone: Tone = status[1] === 'red' ? 'red' : branch ? 'text' : 'bold';
  return [
    [`${branch}${name}`.padEnd(22), nameTone],
    [latency.padStart(6), 'dim'],
    [` ${status[0]} `, status[1]],
    [flag ? detail[0].padEnd(15) : detail[0], detail[1]],
    ...(flag ? [[`◀ ${flag[0]}`, flag[1], true] as Segment] : []),
  ];
}

const BAR_WIDTH = 20;
const CONTEXT_TOTAL = 500;

/** One context-window row: share of the model input drawn as an ASCII bar inside a box. */
function contextRow(label: string, tokens: number, tone: Tone, flag?: string): Line {
  const filled = Math.max(1, Math.round((tokens / CONTEXT_TOTAL) * BAR_WIDTH));
  return [
    ['│ ', 'dim'],
    [label.padEnd(8), tone === 'accent' ? 'text' : tone],
    ['█'.repeat(filled), tone],
    ['░'.repeat(BAR_WIDTH - filled), 'dim'],
    [`${String(tokens).padStart(5)} tok `, tone === 'accent' ? 'dim' : tone],
    ['│', 'dim'],
    ...(flag ? [[` ◀ ${flag}`, tone, true] as Segment] : []),
  ];
}

const BOX_INNER = 1 + 8 + BAR_WIDTH + 10;

/** Claude's answer: run outline, context decomposition and fixes. Flags appear last. */
const ANSWER: Line[] = [
  [
    ['It failed in ', 'text'],
    ['lookup_order', 'bold'],
    ['. Outline of run aaaa1111:', 'text'],
  ],
  [],
  treeRow('', 'support-agent', '5.00s', ['✗', 'red'], ['chain', 'dim']),
  treeRow(
    '├─ ',
    'cache_get ×3',
    '5ms',
    ['✓', 'green'],
    ['"cache miss"', 'amber'],
    ['same key, 3 calls', 'amber'],
  ),
  treeRow('├─ ', 'ChatOpenAI', '1.20s', ['✓', 'green'], ['580 tok', 'dim']),
  treeRow(
    '├─ ',
    'lookup_order',
    '3.00s',
    ['✗', 'red'],
    ['TimeoutError', 'red'],
    ['root cause', 'red'],
  ),
  treeRow(
    '└─ ',
    'notify_user',
    '-',
    ['…', 'amber'],
    ['never ended', 'amber'],
    ['unfinished', 'amber'],
  ),
  [],
  [
    ['Context of ChatOpenAI ', 'text'],
    ['(500 in / 80 out)', 'dim'],
  ],
  [[`┌${'─'.repeat(BOX_INNER)}┐`, 'dim']],
  contextRow('system', 62, 'accent'),
  contextRow('user', 14, 'accent'),
  contextRow('tools', 424, 'amber', '3 identical results'),
  [[`├${'─'.repeat(BOX_INNER)}┤`, 'dim']],
  contextRow('output', 80, 'accent'),
  [[`└${'─'.repeat(BOX_INNER)}┘`, 'dim']],
  [],
  [['Fixes', 'bold']],
  [
    ['1. ', 'dim'],
    ['lookup_order hits its 3s timeout. Retry with backoff.', 'text'],
  ],
  [
    ['2. ', 'dim'],
    ['cache_get repeats the same key. Cache the miss once.', 'text'],
  ],
  [
    ['3. ', 'dim'],
    ['notify_user is never awaited on the error path.', 'text'],
  ],
];

function renderLine(line: Line) {
  if (line.length === 0) return ' ';
  return line.map(([text, tone = 'text', flag], index) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: static content, segments never reorder
      key={index}
      data-flag={flag ? '' : undefined}
      style={TONE[tone]}
    >
      {monoCells(text)}
    </span>
  ));
}

const NON_ASCII_RUN = /([^\x20-\x7e]+)/;

/**
 * The mono web font is subset to Latin, so box-drawing and block glyphs fall back to a font
 * with different advance widths. Pinning each of them to a 1ch cell keeps the ASCII art aligned.
 */
function monoCells(text: string) {
  return text.split(NON_ASCII_RUN).map((part, index) =>
    index % 2 === 0
      ? part
      : [...part].map((glyph, glyphIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: glyphs of a static string
          <span key={`${index}-${glyphIndex}`} className="console-cell">
            {glyph}
          </span>
        )),
  );
}

export default function ClaudeConsoleGraphic() {
  const root = useRef<HTMLDivElement>(null);

  useAnimeScope(root, (el) => {
    const chars = el.querySelectorAll('[data-char]');
    const calls = el.querySelectorAll<HTMLElement>('[data-call]');
    const results = el.querySelectorAll('[data-result]');
    const answer = el.querySelectorAll('[data-answer]');
    const flags = el.querySelectorAll('[data-flag]');
    const caret = el.querySelectorAll('[data-caret]');
    utils.set([...chars, ...answer, ...flags, ...caret], { opacity: 0 });
    utils.set([...calls, ...results], { opacity: 0 });

    const timeline = createTimeline({
      defaults: { ease: 'out(3)' },
      autoplay: onScroll({ target: el, enter: 'bottom-=120 top', repeat: false }),
    }).add(chars, { opacity: [0, 1], duration: 1, delay: stagger(32) }, 300);

    // Each MCP call: show the call with a pulsing bullet while it "runs", then its result.
    for (const call of calls) {
      const bullet = call.querySelector('[data-bullet]');
      const result = call.querySelector('[data-result]');
      if (!bullet || !result) continue;
      timeline
        .add(call, { opacity: [0, 1], duration: 220 }, '+=380')
        .add(bullet, { opacity: [1, 0.25, 1, 0.25, 1], duration: 900, ease: 'inOut(2)' })
        .add(result, { opacity: [0, 1], duration: 260 });
    }

    timeline
      .add(answer, { opacity: [0, 1], duration: 240, delay: stagger(55) }, '+=450')
      .add(flags, { opacity: [0, 1], x: [-6, 0], duration: 380, delay: stagger(160) }, '+=250')
      .add(caret, { opacity: [0, 1], duration: 200 }, '+=200');
  });

  return (
    <figure
      ref={root}
      className="gfx-card console-shadow"
      aria-label="Claude Code using the m4trix trace MCP to find why a support-agent run failed"
    >
      <div className="gfx-head">
        <BrandIcon icon={siClaude} className="h-3.5 w-3.5 text-[#d97757]" />
        <span className="text-text-2">claude</span>
        <span className="truncate">~/support-agent</span>
        <span className="ml-auto hidden sm:inline">m4trix-traces connected</span>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[34rem] px-4 py-4 font-mono text-[11.5px] leading-[1.7] whitespace-pre sm:px-5 sm:text-[12px]">
          <div>
            <span style={TONE.dim}>{'> '}</span>
            {[...PROMPT].map((char, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: characters of a static string
              <span key={index} data-char style={TONE.bold}>
                {char}
              </span>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {TOOL_CALLS.map((tool) => (
              <div key={tool.call[0][0]} data-call>
                <div>
                  <span data-bullet className="inline-block" style={TONE.accent}>
                    {monoCells('⏺ ')}
                  </span>
                  {renderLine(tool.call)}
                </div>
                <div data-result>
                  <span style={TONE.dim}>{monoCells('  ⎿  ')}</span>
                  {renderLine(tool.result)}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3">
            {ANSWER.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static content, lines never reorder
              <div key={index} data-answer>
                {index === 0 ? <span style={TONE.text}>{monoCells('⏺ ')}</span> : '  '}
                {renderLine(line)}
              </div>
            ))}
          </div>

          <div className="mt-3">
            <span style={TONE.dim}>{'> '}</span>
            <span data-caret aria-hidden>
              <span className="console-caret" />
            </span>
          </div>
        </div>
      </div>
    </figure>
  );
}
