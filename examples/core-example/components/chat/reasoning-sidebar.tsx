import type { RefObject } from 'react';
import type { ReasoningEntry } from './types';

type ReasoningSidebarProps = {
  reasoningLog: ReasoningEntry[];
  endRef: RefObject<HTMLDivElement | null>;
};

export function ReasoningSidebar({ reasoningLog, endRef }: ReasoningSidebarProps) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <svg className="h-4 w-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Reasoning</span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {reasoningLog.length === 0 ? (
          <p className="pt-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
            Reasoning traces will appear here.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {reasoningLog.map((entry, index) => (
              <div key={entry.id} className="relative">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    Thought {index + 1}
                  </span>
                  {entry.isStreaming && (
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 dark:bg-amber-500" />
                  )}
                </div>
                <pre className="whitespace-pre-wrap rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 font-sans text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                  {entry.text}
                  {entry.isStreaming && (
                    <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-zinc-400 dark:bg-zinc-500" />
                  )}
                </pre>
              </div>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </aside>
  );
}
