/** @jsxImportSource react */
import React from 'react';
import { Box, Text } from 'ink';

export function Banner(): React.ReactNode {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
      <Text color="gray">@m4trix/evals</Text>
      <Text color="cyan"> · </Text>
      <Text color="gray">eval-agents-simple</Text>
    </Box>
  );
}
