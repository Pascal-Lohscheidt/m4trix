/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';

interface TextBarProps {
  label: string;
  value: number;
  max?: number;
  /** Label width (default 14 to match inspiration) */
  labelWidth?: number;
  /** Bar width in chars (default 20) */
  barWidth?: number;
  /** Format value for display (e.g. v => `${v}%`) */
  format?: (v: number) => string;
  /** Color bar by value: green > 70, yellow 40-70, red < 40 */
  colorByValue?: boolean;
}

function barColor(pct: number): 'green' | 'yellow' | 'red' | undefined {
  if (pct >= 70) return 'green';
  if (pct >= 40) return 'yellow';
  return 'red';
}

export function TextBar({
  label,
  value,
  max = 100,
  labelWidth = 14,
  barWidth = 20,
  format = (v) => String(v),
  colorByValue = true,
}: TextBarProps): React.ReactNode {
  const clamped = Math.max(0, Math.min(max, value));
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  const filled = Math.round((clamped / max) * barWidth);
  const filledBar = '█'.repeat(filled);
  const emptyBar = '░'.repeat(Math.max(0, barWidth - filled));
  const color = colorByValue ? barColor(pct) : undefined;

  return (
    <Text>
      <Text color="gray">{label.padEnd(labelWidth)}</Text>
      {' ['}
      {color ? (
        <>
          <Text color={color}>{filledBar}</Text>
          <Text color="gray">{emptyBar}</Text>
        </>
      ) : (
        filledBar + emptyBar
      )}
      {'] '}
      <Text color={color ?? 'white'} bold>{format(value)}</Text>
    </Text>
  );
}
