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
      className={`m-0 max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-xs ${className ?? ''}`}
    >
      {text}
    </pre>
  );
}
