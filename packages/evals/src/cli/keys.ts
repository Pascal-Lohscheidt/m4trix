import type { Key } from 'ink';

export function isQuitInput(input: string): boolean {
  return input.toLowerCase() === 'q';
}

export function isSearchInput(input: string): boolean {
  return input === '/';
}

export function isPrintableCharacter(input: string): boolean {
  return input.length === 1 && input >= ' ' && input !== '\u007f';
}

export function isBackKey(key: Key): boolean {
  return key.backspace || key.delete;
}
