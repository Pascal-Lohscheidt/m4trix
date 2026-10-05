'use client';

import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

export default function CopyCommand({
  command,
  className = '',
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={`btn-command ${className}`.trim()}
      aria-label={copied ? 'Copied to clipboard' : `Copy command: ${command}`}
    >
      <span className="text-(--accent)" aria-hidden>
        $
      </span>
      <span className="min-w-0 truncate">{command}</span>
      {copied ? (
        <CheckIcon aria-hidden className="h-4 w-4 shrink-0 text-success" weight="bold" />
      ) : (
        <CopyIcon aria-hidden className="h-4 w-4 shrink-0 text-text-3" />
      )}
    </button>
  );
}
