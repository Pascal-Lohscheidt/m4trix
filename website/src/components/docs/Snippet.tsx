import path from 'node:path';
import type { ShikiTransformer } from 'shiki';
import { highlight } from '@/lib/docs/highlight';
import { type ResolvedSnippet, resolveSnippet } from '@/lib/docs/snippets';
import { twoslashTransformer } from '@/lib/docs/twoslash';
import { CodeFrame } from './CodeBlock';

export interface SnippetProps {
  /** Path under `content/snippets`. */
  file: string;
  /** One region name, or several comma-separated (joined in file order). */
  region?: string;
  /** Header label. Default: the file's basename. */
  title?: string;
  /** Line ranges relative to the shown code, e.g. `"2,4-6"`. */
  highlight?: string;
  /** Hover types and `// ^?` queries. Default `true` for `ts` / `tsx`. */
  twoslash?: boolean;
}

/** `"2,4-6"` → {2, 4, 5, 6}; every line must exist in the shown code. */
export function parseLineRanges(spec: string, lineCount: number, label: string): Set<number> {
  const lines = new Set<number>();
  for (const part of spec.split(',').map((p) => p.trim())) {
    if (!part) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    const from = Number(match?.[1]);
    const to = Number(match?.[2] ?? match?.[1]);
    if (!match || from < 1 || to < from || to > lineCount) {
      throw new Error(
        `${label}: highlight "${spec}" is invalid; expected ranges like "2,4-6" within 1-${lineCount}`,
      );
    }
    for (let line = from; line <= to; line++) lines.add(line);
  }
  return lines;
}

/** Nested Shiki blocks in popups shouldn't be tab stops; only the outer `<pre>` scrolls. */
function untabNestedPres(html: string): string {
  let seen = 0;
  return html.replace(/<pre\b[^>]*>/g, (tag) =>
    seen++ === 0 ? tag : tag.replace(/\s+tabindex="0"/, ''),
  );
}

function lineHighlighter(lines: Set<number>): ShikiTransformer {
  return {
    name: 'docs:highlight-lines',
    line(node, line) {
      if (lines.has(line)) this.addClassToHast(node, 'highlighted');
    },
  };
}

/**
 * Runs after twoslash: drops the newline its trailing cut leaves and checks that what twoslash
 * shows is exactly the snippet's code, so highlights and the copy button match the render.
 */
function twoslashGuard(expected: string, label: string): ShikiTransformer {
  return {
    name: 'docs:twoslash-guard',
    preprocess(code) {
      const shown = code.replace(/\n+$/, '');
      if (shown !== expected) {
        throw new Error(`${label}: twoslash output does not match the snippet's code`);
      }
      return shown;
    },
  };
}

const cache = new Map<string, Promise<string>>();

function renderSnippet(
  snippet: ResolvedSnippet,
  label: string,
  lines: Set<number>,
  twoslash: boolean,
): Promise<string> {
  const key = JSON.stringify([
    twoslash ? snippet.twoslashSource : snippet.code,
    snippet.lang,
    twoslash,
    [...lines],
  ]);
  let html = cache.get(key);
  if (!html) {
    html = twoslash
      ? highlight(snippet.twoslashSource, snippet.lang, [
          twoslashTransformer(),
          twoslashGuard(snippet.code, label),
          lineHighlighter(lines),
        ])
      : highlight(snippet.code, snippet.lang, [lineHighlighter(lines)]);
    html = html.then(untabNestedPres).catch((error: unknown) => {
      cache.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label}: ${twoslash ? 'twoslash failed' : 'highlighting failed'}\n${message}`,
        {
          cause: error,
        },
      );
    });
    if (cache.size > 200) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** A compiled snippet from `content/snippets`, optionally narrowed to regions. */
export async function Snippet({
  file,
  region,
  title,
  highlight: highlightLines,
  twoslash = true,
}: SnippetProps) {
  const snippet = await resolveSnippet(file, region);
  const label = `<Snippet file="${snippet.file}"${region ? ` region="${region}"` : ''}>`;
  const lines = highlightLines
    ? parseLineRanges(highlightLines, snippet.lineMap.length, label)
    : new Set<number>();
  const useTwoslash = twoslash !== false && (snippet.lang === 'ts' || snippet.lang === 'tsx');
  const html = await renderSnippet(snippet, label, lines, useTwoslash);
  return (
    <CodeFrame
      code={snippet.code}
      lang={snippet.lang}
      title={title ?? path.basename(snippet.file)}
      html={html}
    />
  );
}
