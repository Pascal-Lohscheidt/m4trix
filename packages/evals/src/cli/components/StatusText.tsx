/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';
import type { EvalStatus } from '../types';

interface StatusTextProps {
  status: EvalStatus;
}

export function StatusText({ status }: StatusTextProps): React.ReactNode {
  const color = status === 'PASS' ? 'green' : status === 'RUNNING' ? 'yellow' : 'red';
  return <Text color={color}>({status})</Text>;
}
