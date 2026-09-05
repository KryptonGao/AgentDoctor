import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  repositoryName: string;
  branch: string;
  activeTab: string;
}

export const Header: React.FC<HeaderProps> = ({ repositoryName, branch, activeTab }) => {
  const tabs = [
    { key: "1", label: "Overview", id: "overview" },
    { key: "2", label: "Context", id: "context" },
    { key: "3", label: "Repository", id: "repository" },
    { key: "4", label: "Verification", id: "verification" },
    { key: "5", label: "Sessions", id: "sessions" },
    { key: "6", label: "Fixes", id: "fixes" },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="cyan">AgentDoctor </Text>
          <Text dimColor>│ </Text>
          <Text bold>{repositoryName}</Text>
          <Text color="green"> ({branch} ✓)</Text>
        </Box>
        <Box>
          <Text dimColor>ESLint for AI Agent Efficiency</Text>
        </Box>
      </Box>

      <Box marginTop={1} gap={2}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <Box key={tab.id}>
              <Text bold={isActive} color={isActive ? "cyan" : "gray"} underline={isActive}>
                [{tab.key}] {tab.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
