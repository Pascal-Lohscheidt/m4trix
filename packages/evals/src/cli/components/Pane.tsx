/** @jsxImportSource react */
import React from 'react';
import { Box } from 'ink';

interface PaneProps {
  children: React.ReactNode;
  width?: number;
  flexGrow?: number;
  marginLeft?: number;
  focused?: boolean;
}

export function Pane({
  children,
  width,
  flexGrow,
  marginLeft,
  focused = false,
}: PaneProps): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      width={width}
      flexGrow={flexGrow}
      marginLeft={marginLeft}
      borderStyle={focused ? 'single' : 'round'}
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      {children}
    </Box>
  );
}
