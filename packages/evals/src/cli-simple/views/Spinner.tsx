/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇'];

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = 'Running' }: SpinnerProps): React.ReactNode {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color="cyan">
      {FRAMES[frame]} {label}
    </Text>
  );
}
