/** @jsxImportSource react */
import type { CliState } from '../types';

export function getFooterText(state: CliState): string {
  if (state.level === 'datasets') {
    return state.focus === 'right'
      ? '↑↓ scroll  Tab focus left  / search  q quit'
      : '↑↓ move  Enter open  Tab focus right  / search  q quit';
  }
  if (state.level === 'runs') {
    return '↑↓ move  Enter details  Backspace datasets  Tab focus  q quit';
  }
  if (state.level === 'details') {
    return '↑↓ scroll  Backspace runs  Tab focus  q quit';
  }
  return '↑↓ move  Enter add/remove  S start run  / search  Esc cancel  q quit';
}
