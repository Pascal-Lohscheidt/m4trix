'use client';

import { Highlight } from 'prism-react-renderer';
import { getCodeTheme } from '@/lib/code-themes';
import { useDataMode } from '@/lib/useDataMode';

export type CodeLanguage = 'typescript' | 'bash' | 'python';

export interface CodeBlockProps {
  code: string;
  language: CodeLanguage;
  filename?: string;
  className?: string;
  /** Extra classes per line, keyed by 1-based line number. */
  lineClassName?: (line: number) => string;
}

export default function CodeBlock({
  code,
  language,
  filename,
  className = '',
  lineClassName,
}: CodeBlockProps) {
  const mode = useDataMode();
  const theme = getCodeTheme(mode);
  const label =
    filename ?? (language === 'bash' ? 'bash' : language === 'python' ? 'python' : 'typescript');

  return (
    <div
      className={`code-block min-w-0 overflow-hidden rounded-lg border font-mono text-xs ${className}`.trim()}
      style={{
        borderColor: 'var(--border-md)',
        background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
      }}
    >
      <div
        className="code-block-hdr flex items-center justify-between border-b px-3 py-1.5 text-[10px]"
        style={{ borderColor: 'var(--border)', color: 'var(--text-4)' }}
      >
        <span>{label}</span>
        <span>{language}</span>
      </div>
      <Highlight theme={theme} code={code.trim()} language={language}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className="code-block-body overflow-x-auto px-3 py-3 text-[12px] leading-[1.65]"
            style={{ ...style, margin: 0, background: 'transparent' }}
          >
            <code>
              {tokens.map((line, lineIndex) => (
                <span
                  key={lineIndex}
                  {...getLineProps({ line })}
                  className={`code-block-line block min-h-[1.65em] ${lineClassName?.(lineIndex + 1) ?? ''}`.trim()}
                >
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} {...getTokenProps({ token })} />
                  ))}
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}
