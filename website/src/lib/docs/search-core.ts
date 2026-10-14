/** Search records and scoring. No Node APIs: shared by the ⌘K dialog and the MCP server. */

export interface SearchRecord {
  /** `slug#anchor`, unique. */
  id: string;
  slug: string;
  href: string;
  tab: string;
  pageTitle: string;
  /** Section heading; absent for the intro before the first heading. */
  heading?: string;
  text: string;
}

export interface SearchHit {
  record: SearchRecord;
  score: number;
}

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9@._:-]+/)
    .map((t) => t.replace(/^[._:-]+|[._:-]+$/g, ''))
    .filter((t) => t.length > 1);
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < 5) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Ranks sections by term matches, weighting page titles and headings over body text.
 * Sections that contain every term rank above partial matches.
 */
export function searchRecords(records: SearchRecord[], query: string, limit = 10): SearchHit[] {
  const words = terms(query);
  if (!words.length) return [];
  const phrase = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const record of records) {
    const title = record.pageTitle.toLowerCase();
    const heading = (record.heading ?? '').toLowerCase();
    const text = record.text.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const word of words) {
      const inTitle = title.includes(word);
      const inHeading = heading.includes(word);
      const inText = count(text, word);
      if (inTitle || inHeading || inText) matched++;
      score += (inTitle ? 6 : 0) + (inHeading ? 8 : 0) + Math.min(inText, 5);
    }
    if (!matched) continue;
    if (heading.includes(phrase) || title.includes(phrase)) score += 10;
    else if (text.includes(phrase)) score += 4;
    if (matched === words.length) score *= 2;
    hits.push({ record, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A short excerpt of `text` around the first matching term. */
export function excerpt(text: string, query: string, length = 160): string {
  const lower = text.toLowerCase();
  const first = terms(query)
    .map((t) => lower.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (first ?? 0) - 40);
  const slice = text.slice(start, start + length).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + length < text.length ? '…' : ''}`;
}
