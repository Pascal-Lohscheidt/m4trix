import { TerminalWindowIcon } from '@phosphor-icons/react/dist/ssr';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { highlight, normalizeLang } from '@/lib/docs/highlight';
import { CopyButton } from './CopyButton';

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
  'data-meta'?: string;
}

export interface CodeInfo {
  code: string;
  lang: string;
  title?: string;
}

const LANG_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  bash: 'Terminal',
  shell: 'Terminal',
  json: 'JSON',
  yaml: 'YAML',
  diff: 'Diff',
  http: 'HTTP',
  html: 'HTML',
  css: 'CSS',
  text: 'Text',
};

/** Reads code, language and `title="…"` meta from the `<pre><code>` MDX produces. */
export function readCodeInfo(pre: ReactNode): CodeInfo | null {
  if (!isValidElement(pre)) return null;
  const code = (pre as ReactElement<{ children?: ReactNode }>).props.children;
  if (!isValidElement(code)) return null;
  const props = (code as ReactElement<CodeElementProps>).props;
  const lang = normalizeLang(/language-([\w-]+)/.exec(props.className ?? '')?.[1]);
  const title = /title="([^"]+)"/.exec(props['data-meta'] ?? '')?.[1];
  const text = typeof props.children === 'string' ? props.children : String(props.children ?? '');
  return { code: text.replace(/\n$/, ''), lang, title };
}

export function langLabel(lang: string): string {
  return LANG_LABELS[lang] ?? lang;
}

/**
 * Highlighted code with a header (title or language) and a copy button. `html` replaces the
 * default highlighting (e.g. twoslash output); the copy button still copies `code`.
 */
export async function CodeFrame({
  code,
  lang,
  title,
  html: prerendered,
  bare = false,
}: CodeInfo & { html?: string; bare?: boolean }) {
  const html = prerendered ?? (await highlight(code, lang));
  const terminal = lang === 'bash' || lang === 'shell';
  const body = (
    <div
      className="docs-code-body"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output from our own content
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
  if (bare) return body;
  return (
    <figure className="docs-code not-prose">
      <figcaption className="docs-code-head">
        <span className="flex min-w-0 items-center gap-2">
          {terminal ? <TerminalWindowIcon aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null}
          <span className="truncate">{title ?? langLabel(lang)}</span>
        </span>
        <CopyButton value={code} />
      </figcaption>
      {body}
    </figure>
  );
}

/** MDX `pre` override. */
export async function Pre(props: { children?: ReactNode }) {
  const info = readCodeInfo(<pre>{props.children}</pre>);
  if (!info) return <pre>{props.children}</pre>;
  return <CodeFrame {...info} />;
}
