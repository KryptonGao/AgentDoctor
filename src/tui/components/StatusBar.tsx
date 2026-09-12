import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  statusMessage?: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({ statusMessage }) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      {statusMessage && (
        <Box marginBottom={1} paddingX={1} borderStyle="single" borderColor="yellow">
          <Text color="yellow">{statusMessage}</Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text dimColor>
          <Text bold color="cyan">1-7/Tab</Text> Views │{" "}
          <Text bold color="cyan">↑↓/jk</Text> Navigate │{" "}
          <Text bold color="cyan">Enter/p</Text> Prompt │{" "}
          <Text bold color="cyan">P</Text> Copy All │{" "}
          <Text bold color="cyan">f</Text> Fixes │{" "}
          <Text bold color="cyan">r</Text> Rescan │{" "}
          <Text bold color="cyan">q</Text> Quit
        </Text>
      </Box>
    </Box>
  );
};
