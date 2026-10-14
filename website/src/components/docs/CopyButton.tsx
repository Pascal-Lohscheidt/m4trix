'use client';

import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

export function CopyButton({
  value,
  label = 'Copy code',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={`docs-icon-btn ${className}`.trim()}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden className="h-3.5 w-3.5" style={{ color: 'var(--green)' }} />
      ) : (
        <CopyIcon aria-hidden className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
