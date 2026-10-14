import {
  createHighlighter,
  type Highlighter,
  type ShikiTransformer,
  type ThemeRegistration,
} from 'shiki';

/**
 * Server-side highlighting with Shiki. Both themes are emitted as CSS variables
 * (`--shiki-dark` / `--shiki-light`), so switching `data-mode` needs no JavaScript.
 * Colors follow the site palette in `src/lib/code-themes.ts`.
 */

type Palette = {
  fg: string;
  comment: string;
  string: string;
  number: string;
  keyword: string;
  fn: string;
  type: string;
  property: string;
  punctuation: string;
  deleted: string;
};

function theme(name: string, type: 'dark' | 'light', c: Palette): ThemeRegistration {
  return {
    name,
    type,
    colors: { 'editor.background': '#00000000', 'editor.foreground': c.fg },
    tokenColors: [
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: c.comment, fontStyle: 'italic' },
      },
      {
        scope: ['string', 'string.quoted', 'string.template', 'markup.inserted'],
        settings: { foreground: c.string },
      },
      { scope: ['constant.numeric', 'constant.language'], settings: { foreground: c.number } },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.control',
          'keyword.operator.new',
          'keyword.operator.expression',
          'variable.language',
        ],
        settings: { foreground: c.keyword },
      },
      {
        scope: ['entity.name.function', 'support.function', 'entity.name.command'],
        settings: { foreground: c.fn },
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'support.type',
          'support.class',
          'entity.other.inherited-class',
          'entity.name.tag',
        ],
        settings: { foreground: c.type },
      },
      {
        scope: [
          'variable.other.property',
          'variable.other.object.property',
          'meta.object-literal.key',
          'support.type.property-name',
          'entity.other.attribute-name',
        ],
        settings: { foreground: c.property },
      },
      {
        scope: ['punctuation', 'keyword.operator', 'meta.brace', 'punctuation.definition.string'],
        settings: { foreground: c.punctuation },
      },
      { scope: ['markup.deleted'], settings: { foreground: c.deleted } },
    ],
  };
}

const darkTheme = theme('m4trix-dark', 'dark', {
  fg: '#d4d4d8',
  comment: '#71717a',
  string: '#4ade80',
  number: '#fbbf24',
  keyword: '#c4b5fd',
  fn: '#67e8f9',
  type: '#67e8f9',
  property: '#6ee7b7',
  punctuation: '#8b8b96',
  deleted: '#f87171',
});

const lightTheme = theme('m4trix-light', 'light', {
  fg: '#2e2e3a',
  comment: '#8a8aa3',
  string: '#15803d',
  number: '#b45309',
  keyword: '#6d28d9',
  fn: '#0e7490',
  type: '#0e7490',
  property: '#047857',
  punctuation: '#6b6b80',
  deleted: '#dc2626',
});

const LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'shell',
  'yaml',
  'diff',
  'http',
  'html',
  'css',
];

const LANG_ALIASES: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  sh: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
};

let highlighter: Promise<Highlighter> | undefined;

function getHighlighter() {
  highlighter ??= createHighlighter({ themes: [darkTheme, lightTheme], langs: LANGS });
  return highlighter;
}

export function normalizeLang(lang: string | undefined): string {
  const key = (lang ?? '').toLowerCase();
  const resolved = LANG_ALIASES[key] ?? key;
  return LANGS.includes(resolved) ? resolved : 'text';
}

/** Highlighted `<pre class="shiki">` HTML for a code block. */
export async function highlight(
  code: string,
  lang: string | undefined,
  transformers: ShikiTransformer[] = [],
): Promise<string> {
  const shiki = await getHighlighter();
  return shiki.codeToHtml(code, {
    lang: normalizeLang(lang),
    themes: { dark: darkTheme.name ?? 'm4trix-dark', light: lightTheme.name ?? 'm4trix-light' },
    defaultColor: false,
    transformers,
  });
}
