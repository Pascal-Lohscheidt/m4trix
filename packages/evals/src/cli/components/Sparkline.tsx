/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';

/** Block characters for sparkline: ▁▂▃▄▅▆▇█ (8 levels) */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

interface SparklineProps {
  /** Values to plot (e.g. latency in ms) */
  data: number[];
  /** Max width in chars (default: data length or 24) */
  width?: number;
  /** Optional label prefix */
  label?: string;
}

export function Sparkline({
  data,
  width,
  label,
}: SparklineProps): React.ReactNode {
  if (data.length === 0) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const targetWidth = width ?? Math.min(data.length, 24);

  let values: number[];
  if (data.length <= targetWidth) {
    values = data;
  } else {
    const step = data.length / targetWidth;
    values = Array.from({ length: targetWidth }, (_, i) => {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      const slice = data.slice(start, end);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });
  }

  const spark = values
    .map((v) => {
      const normalized = (v - min) / range;
      const idx = Math.min(7, Math.floor(normalized * 8));
      return BLOCKS[idx];
    })
    .join('');

  return (
    <Text>
      {label !== undefined && label !== '' ? (
        <Text color="gray">{label.padEnd(14)} </Text>
      ) : null}
      <Text color="cyan">{spark}</Text>
    </Text>
  );
}
