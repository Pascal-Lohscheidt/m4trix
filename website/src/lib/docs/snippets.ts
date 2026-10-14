import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Code snippets that live as real, typechecked files in `content/snippets` and are shown in
 * the docs by region (`// #region wiring` … `// #endregion wiring`). Server only.
 */

export const SNIPPETS_DIR = path.join(process.cwd(), 'content/snippets');

export interface Snippet {
  /** Resolved, dedented code: the selected regions without region markers or twoslash notations. */
  code: string;
  /** From the file extension (`ts`, `tsx`, …). */
  lang: string;
  /** 1-based line in the source file of the first shown line. */
  startLine: number;
  /** `lineMap[i]` = 1-based source line of shown line `i` (0-based `i`). */
  lineMap: number[];
}

export interface ResolvedSnippet extends Snippet {
  /** Path under `content/snippets`, normalised. */
  file: string;
  /**
   * The whole file for twoslash: the shown lines (dedented, twoslash notations kept) and
   * everything else wrapped in `// ---cut-start---` / `// ---cut-end---`, so types resolve
   * against the full file while twoslash outputs exactly `code`.
   */
  twoslashSource: string;
}

const REGION_START = /^\s*\/\/\s*#region\s+(\S+)\s*$/;
const REGION_END = /^\s*\/\/\s*#endregion(?:\s+(\S+))?\s*$/;
/** Same patterns twoslash removes from its output (queries, compiler flags, custom tags). */
const TWOSLASH_QUERY = /^\s*\/\/\s*\^(\?|\||\^+)( .*)?$/;
const TWOSLASH_FLAG = /^\/\/\s?@(\w+)(:\s?.+)?$/;
const TWOSLASH_CUT = /^\s*\/\/\s?---cut(-before|-after|-start|-end)?---\s*$/;

const LANGS: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  sh: 'bash',
  bash: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
};

class SnippetError extends Error {
  constructor(file: string, message: string) {
    super(`Snippet "${file}": ${message}`);
    this.name = 'SnippetError';
  }
}

/** Absolute path of a snippet; rejects anything outside `content/snippets`. */
export function snippetPath(file: string): string {
  if (!file || path.isAbsolute(file)) {
    throw new SnippetError(file, 'expected a path relative to content/snippets');
  }
  const absolute = path.resolve(SNIPPETS_DIR, file);
  const relative = path.relative(SNIPPETS_DIR, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SnippetError(file, 'path escapes content/snippets');
  }
  return absolute;
}

export function snippetLang(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return LANGS[ext] ?? (ext || 'text');
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * Removes `n` columns of indentation. A `// ^?` query keeps its caret under the same
 * character of the (dedented) line above, even when its `//` sits left of the indentation.
 */
function dedentLine(line: string, n: number, file: string, lineNo: number): string {
  if (n === 0 || isBlank(line)) return isBlank(line) ? '' : line;
  if (indentOf(line) >= n) return line.slice(n);
  if (TWOSLASH_QUERY.test(line)) {
    const caret = line.indexOf('^');
    const column = caret - n;
    if (column < 2) {
      throw new SnippetError(file, `line ${lineNo}: twoslash query points left of the region`);
    }
    return `//${' '.repeat(column - 2)}${line.slice(caret)}`;
  }
  // Under-indented code (e.g. a multi-line template literal): keep it as is.
  return line.trimStart();
}

interface Entry {
  /** 0-based source line. */
  index: number;
  text: string;
  /** Twoslash notation: fed to twoslash, left out of `code`. */
  notation: boolean;
}

/** Resolves a snippet's code and the matching twoslash source. */
export async function resolveSnippet(file: string, region?: string): Promise<ResolvedSnippet> {
  const absolute = snippetPath(file);
  const name = path.relative(SNIPPETS_DIR, absolute).split(path.sep).join('/');
  let source: string;
  try {
    source = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SnippetError(name, `file not found in content/snippets`);
    }
    throw error;
  }

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  // Region markers and the regions each line belongs to.
  const marker = new Array<boolean>(lines.length).fill(false);
  const regionsOf: string[][] = [];
  const declared = new Set<string>();
  const open: { name: string; line: number }[] = [];
  lines.forEach((line, i) => {
    if (TWOSLASH_CUT.test(line)) {
      throw new SnippetError(name, `line ${i + 1}: use regions instead of twoslash cut markers`);
    }
    const start = REGION_START.exec(line);
    const end = start ? null : REGION_END.exec(line);
    if (start) {
      marker[i] = true;
      open.push({ name: start[1], line: i + 1 });
      declared.add(start[1]);
    } else if (end) {
      marker[i] = true;
      const top = open.pop();
      if (!top) throw new SnippetError(name, `line ${i + 1}: #endregion without #region`);
      if (end[1] && end[1] !== top.name) {
        throw new SnippetError(
          name,
          `line ${i + 1}: #endregion ${end[1]} closes #region ${top.name} (line ${top.line})`,
        );
      }
    }
    regionsOf.push(open.map((r) => r.name));
  });
  if (open.length) {
    throw new SnippetError(name, `unclosed #region ${open.map((r) => r.name).join(', ')}`);
  }

  const wanted = region
    ?.split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (region !== undefined && !wanted?.length) {
    throw new SnippetError(name, `empty region "${region}"`);
  }
  for (const r of wanted ?? []) {
    if (!declared.has(r)) {
      const available = [...declared].join(', ') || 'none';
      throw new SnippetError(name, `no region "${r}" (regions: ${available})`);
    }
  }
  const selected = (i: number) =>
    !marker[i] && (!wanted || regionsOf[i].some((r) => wanted.includes(r)));

  // Shown lines in file order. Where several regions are joined across hidden code, keep one
  // blank source line from the gap (if there is one) so the parts don't run together.
  let shown: Entry[] = [];
  let gap: number[] = [];
  lines.forEach((text, index) => {
    if (marker[index]) return;
    if (!selected(index)) {
      gap.push(index);
      return;
    }
    if (gap.length && shown.length) {
      const blank = gap.find((g) => isBlank(lines[g]));
      const last = shown[shown.length - 1];
      if (blank !== undefined && !isBlank(last.text) && !isBlank(text)) {
        shown.push({ index: blank, text: '', notation: false });
      }
    }
    gap = [];
    shown.push({ index, text, notation: false });
  });
  // Trim blank lines at both ends.
  while (shown.length && isBlank(shown[0].text)) shown.shift();
  while (shown.length && isBlank(shown[shown.length - 1].text)) shown.pop();
  if (!shown.length) {
    throw new SnippetError(name, wanted ? `region "${region}" is empty` : 'file is empty');
  }

  const indent = Math.min(
    ...shown
      .filter((e) => !isBlank(e.text) && !TWOSLASH_QUERY.test(e.text))
      .map((e) => indentOf(e.text)),
  );
  shown = shown.map((entry) => {
    const text = dedentLine(
      entry.text,
      Number.isFinite(indent) ? indent : 0,
      name,
      entry.index + 1,
    );
    return { ...entry, text, notation: TWOSLASH_QUERY.test(text) || TWOSLASH_FLAG.test(text) };
  });

  const code = shown.filter((e) => !e.notation);
  if (!code.length) throw new SnippetError(name, 'nothing to show besides twoslash notations');

  // Twoslash source: every non-marker line in order; hidden runs are cut.
  const byIndex = new Map(shown.map((entry) => [entry.index, entry]));
  const twoslash: string[] = [];
  let hidden: string[] = [];
  const flushHidden = () => {
    if (hidden.length) twoslash.push('// ---cut-start---', ...hidden, '// ---cut-end---');
    hidden = [];
  };
  lines.forEach((text, index) => {
    if (marker[index]) return;
    const entry = byIndex.get(index);
    if (!entry) {
      hidden.push(text);
      return;
    }
    flushHidden();
    twoslash.push(entry.text);
  });
  flushHidden();

  return {
    file: name,
    code: code.map((e) => e.text).join('\n'),
    lang: snippetLang(name),
    startLine: code[0].index + 1,
    lineMap: code.map((e) => e.index + 1),
    twoslashSource: twoslash.join('\n'),
  };
}

/** Reads a snippet (optionally only some comma-separated regions), dedented, without markers. */
export async function readSnippet(
  file: string,
  region?: string,
): Promise<{
  code: string;
  lang: string;
  startLine: number;
  lineMap: number[];
}> {
  const { code, lang, startLine, lineMap } = await resolveSnippet(file, region);
  return { code, lang, startLine, lineMap };
}
