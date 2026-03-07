/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';

interface ListItemProps {
  selected: boolean;
  label: string;
  itemKey: string;
}

export function ListItem({
  selected,
  label,
  itemKey,
}: ListItemProps): React.ReactNode {
  return (
    <Text key={itemKey} color={selected ? 'cyan' : 'gray'} bold={selected}>
      {selected ? '▸ ' : '  '}
      {label}
    </Text>
  );
}
