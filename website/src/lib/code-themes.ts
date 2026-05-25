import type { PrismTheme } from 'prism-react-renderer';

const darkTheme: PrismTheme = {
  plain: {
    color: '#a1a1aa',
    backgroundColor: 'transparent',
  },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#52525b', fontStyle: 'italic' },
    },
    { types: ['namespace'], style: { opacity: 0.7 } },
    { types: ['string', 'char', 'attr-value', 'regex', 'inserted'], style: { color: '#4ade80' } },
    { types: ['number', 'boolean'], style: { color: '#fbbf24' } },
    { types: ['keyword', 'atrule'], style: { color: '#c4b5fd' } },
    { types: ['function', 'tag', 'class-name'], style: { color: '#67e8f9' } },
    { types: ['operator', 'punctuation', 'symbol'], style: { color: '#71717a' } },
    { types: ['property', 'constant', 'variable'], style: { color: '#6ee7b7' } },
    { types: ['deleted'], style: { color: '#f87171' } },
    { types: ['builtin', 'important'], style: { color: '#f472b6' } },
  ],
};

const lightTheme: PrismTheme = {
  plain: {
    color: '#4b4b60',
    backgroundColor: 'transparent',
  },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#a0a0b8', fontStyle: 'italic' },
    },
    { types: ['namespace'], style: { opacity: 0.7 } },
    { types: ['string', 'char', 'attr-value', 'regex', 'inserted'], style: { color: '#16a34a' } },
    { types: ['number', 'boolean'], style: { color: '#d97706' } },
    { types: ['keyword', 'atrule'], style: { color: '#7c3aed' } },
    { types: ['function', 'tag', 'class-name'], style: { color: '#0891b2' } },
    { types: ['operator', 'punctuation', 'symbol'], style: { color: '#7b7b96' } },
    { types: ['property', 'constant', 'variable'], style: { color: '#059669' } },
    { types: ['deleted'], style: { color: '#dc2626' } },
    { types: ['builtin', 'important'], style: { color: '#db2777' } },
  ],
};

export function getCodeTheme(mode: 'dark' | 'light'): PrismTheme {
  return mode === 'light' ? lightTheme : darkTheme;
}
