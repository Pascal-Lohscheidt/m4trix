import type { ReactNode } from 'react';

export function JsonBlock({ value, className }: { value: unknown; className?: string }): ReactNode {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    text = String(value);
  }
  return (
    <pre
      className={`glass-well m-0 max-h-80 overflow-auto rounded-2xl p-3 font-mono text-xs leading-relaxed text-zinc-300 ${className ?? ''}`}
    >
      {text}
    </pre>
  );
}
