const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
} as const;

export function printBanner(): void {
  const c = (s: string) => `${ansi.cyan}${s}${ansi.reset}`;
  const d = (s: string) => `${ansi.dim}${s}${ansi.reset}`;

  const lines = [
    '',
    `  ${c('╭─────────────────────────────────────────────╮')}`,
    `  ${c('│')}  ${d('@m4trix/evals')}  ${c('·')}  ${d('eval-agents-simple')}  ${c('│')}`,
    `  ${c('╰─────────────────────────────────────────────╯')}`,
    '',
  ];

  console.log(lines.join('\n'));
}
