/**
 * One line scanner for docs MDX, shared by the table of contents, search indexing and the
 * Markdown export so they agree on what is code and what is a heading.
 *
 * Fences follow CommonMark: up to three spaces of indent, then three or more backticks or
 * tildes; a fence closes on the same character repeated at least as often, with nothing else on
 * the line. That keeps a four-backtick block containing ``` intact.
 */

export type MdxLineKind = 'prose' | 'fence-open' | 'code' | 'fence-close';

export interface MdxLine {
  text: string;
  kind: MdxLineKind;
  /** ATX heading on a prose line. `raw` is the heading's inline Markdown. */
  heading?: { depth: number; raw: string };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

export function scanMdx(body: string): MdxLine[] {
  const lines: MdxLine[] = [];
  let fence: string | null = null;
  for (const text of body.split(/\r?\n/)) {
    if (fence !== null) {
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (close.test(text)) {
        lines.push({ text, kind: 'fence-close' });
        fence = null;
      } else {
        lines.push({ text, kind: 'code' });
      }
      continue;
    }
    const open = FENCE_OPEN.exec(text);
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (open && !(open[1][0] === '`' && text.slice(open[0].length).includes('`'))) {
      fence = open[1];
      lines.push({ text, kind: 'fence-open' });
      continue;
    }
    const heading = HEADING.exec(text);
    lines.push(
      heading
        ? { text, kind: 'prose', heading: { depth: heading[1].length, raw: heading[2] } }
        : { text, kind: 'prose' },
    );
  }
  return lines;
}
