/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';

interface SectionHeaderProps {
  children: React.ReactNode;
}

export function SectionHeader({
  children,
}: SectionHeaderProps): React.ReactNode {
  return (
    <Text color="cyan" bold>
      {children}
    </Text>
  );
}
