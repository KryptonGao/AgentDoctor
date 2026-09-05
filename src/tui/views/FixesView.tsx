import React from "react";
import { Box, Text } from "ink";
import { ScanResult, Fix } from "../../core/types.js";

interface FixesViewProps {
  result: ScanResult;
  selectedFixIndex: number;
}

export const FixesView: React.FC<FixesViewProps> = ({ result, selectedFixIndex }) => {
  const fixes = result.availableFixes;

  if (fixes.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box borderStyle="round" borderColor="green" padding={1}>
          <Text color="green">✓ No pending fixes! Repository instructions are cleanly optimized.</Text>
        </Box>
      </Box>
    );
  }

  const activeFix: Fix = fixes[selectedFixIndex] || fixes[0];

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Top summary header */}
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="cyan">{fixes.length} Fixes Available</Text>
          <Text dimColor>Review diff and press Enter to apply safely to your repository.</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color="green" bold>[Enter] Apply Selected</Text>
          <Text color="yellow" bold>[a] Apply All Safe Fixes</Text>
          <Text color="cyan" bold>[P] Copy All Fix Prompts</Text>
        </Box>
      </Box>

      {/* Two columns: Fixes list on left, Diff viewer on right */}
      <Box marginTop={1} justifyContent="space-between">
        {/* Left column: Fixes list */}
        <Box flexDirection="column" width="38%" borderStyle="round" borderColor="gray" paddingX={1}>
          <Box marginBottom={1}>
            <Text bold underline>Available Fixes</Text>
          </Box>
          {fixes.map((fix, idx) => {
            const isSelected = idx === selectedFixIndex;
            return (
              <Box key={fix.id} flexDirection="column" marginY={0}>
                <Box gap={1}>
                  <Text color={isSelected ? "cyan" : undefined}>{isSelected ? ">" : " "} </Text>
                  <Text bold={isSelected} color={isSelected ? "cyan" : fix.isSafe ? "green" : "white"}>
                    {fix.isSafe ? "✓ " : "• "}
                    {fix.title}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Right column: Selected fix diff preview */}
        <Box flexDirection="column" width="60%" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color="cyan">{activeFix.title}</Text>
            <Text color={activeFix.isSafe ? "green" : "yellow"}>
              {activeFix.isSafe ? "Safe (Deterministic)" : "Review Needed"}
            </Text>
          </Box>
          <Text dimColor>File: {activeFix.file}</Text>
          <Text dimColor>{activeFix.description}</Text>

          <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
            <Box marginBottom={0}>
              <Text bold dimColor>Proposed Unified Diff:</Text>
            </Box>
            {activeFix.diff ? (
              activeFix.diff.split("\n").slice(0, 14).map((line, i) => {
                if (line.startsWith("+") && !line.startsWith("+++")) {
                  return <Text key={i} color="green">{line}</Text>;
                } else if (line.startsWith("-") && !line.startsWith("---")) {
                  return <Text key={i} color="red">{line}</Text>;
                } else if (line.startsWith("@@")) {
                  return <Text key={i} color="cyan">{line}</Text>;
                }
                return <Text key={i} dimColor>{line}</Text>;
              })
            ) : (
              <Box flexDirection="column">
                <Text color="red">- {activeFix.oldText}</Text>
                <Text color="green">+ {activeFix.newText || "[remove line]"}</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
