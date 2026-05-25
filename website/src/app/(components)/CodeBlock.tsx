'use client';

import { Highlight } from 'prism-react-renderer';
import { getCodeTheme } from '@/lib/code-themes';
import { useDataMode } from '@/lib/useDataMode';

export type CodeLanguage = 'typescript' | 'bash';

export interface CodeBlockProps {
  code: string;
  language: CodeLanguage;
  filename?: string;
  className?: string;
}

export default function CodeBlock({ code, language, filename, className = '' }: CodeBlockProps) {
  const mode = useDataMode();
  const theme = getCodeTheme(mode);
  const label = filename ?? (language === 'bash' ? 'bash' : 'typescript');

  return (
    <div className={`code-block ${className}`.trim()}>
      <div className="code-block-hdr">
        <span>{label}</span>
        <span>{language}</span>
      </div>
      <Highlight theme={theme} code={code.trim()} language={language}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre className="code-block-body" style={{ ...style, background: 'transparent' }}>
            <code>
              {tokens.map((line, lineIndex) => (
                <span key={lineIndex} {...getLineProps({ line })} className="code-block-line">
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
