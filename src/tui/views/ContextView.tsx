import React from "react";
import { Box, Text } from "ink";
import { ScanResult } from "../../core/types.js";

interface ContextViewProps {
  result: ScanResult;
  selectedIndex: number;
}

export const ContextView: React.FC<ContextViewProps> = ({ result, selectedIndex }) => {
  const { contextSignalDensity, scores, findings } = result;
  const contextFindings = findings.filter((f) => f.category === "context");

  const density = contextSignalDensity;
  const wasteful = density.totalTokens - density.usefulTokens;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Top statistics card */}
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-between">
        <Box flexDirection="column" width="45%">
          <Text bold color="cyan">Context Health: {scores.context.score} / 100</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Total Context: {density.totalTokens.toLocaleString()} tokens</Text>
            <Box marginTop={1} flexDirection="column" gap={0}>
              <Text color="green">  Useful:    {density.usefulTokens.toLocaleString().padStart(6)} tokens</Text>
              <Text color="yellow">  Duplicate: {density.duplicateTokens.toLocaleString().padStart(6)} tokens</Text>
              <Text color="blue">  Inferable: {density.inferableTokens.toLocaleString().padStart(6)} tokens</Text>
              <Text color="red">  Stale:     {density.staleTokens.toLocaleString().padStart(6)} tokens</Text>
              <Text color="magenta">  Low-value: {density.lowValueTokens.toLocaleString().padStart(6)} tokens</Text>
            </Box>
          </Box>
        </Box>

        <Box flexDirection="column" width="45%" justifyContent="center" alignItems="center">
          <Text dimColor>Context Signal Density</Text>
          <Box marginTop={1}>
            <Text bold color={density.densityPercent >= 75 ? "green" : density.densityPercent >= 50 ? "yellow" : "red"}>
              {density.densityPercent}%
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Potential Waste Reduction: </Text>
            <Text bold color="green">{wasteful.toLocaleString()} tokens</Text>
          </Box>
        </Box>
      </Box>

      {/* Issues list */}
      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text bold underline>Context Issues ({contextFindings.length})</Text>
        </Box>

        {contextFindings.length === 0 ? (
          <Box borderStyle="round" borderColor="green" padding={1}>
            <Text color="green">✓ All context instructions are concise, verified, and high-signal!</Text>
          </Box>
        ) : (
          contextFindings.map((issue, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <Box
                key={issue.id}
                flexDirection="column"
                paddingX={1}
                borderStyle={isSelected ? "round" : undefined}
                borderColor="cyan"
              >
                <Box gap={1}>
                  <Text bold color={isSelected ? "cyan" : undefined}>{isSelected ? ">" : " "} </Text>
                  <Text bold color={issue.severity === "high" ? "red" : issue.severity === "medium" ? "yellow" : "blue"}>
                    {issue.severity.toUpperCase().padEnd(5)}
                  </Text>
                  <Text bold={isSelected}>{issue.title}</Text>
                </Box>
                {isSelected && (
                  <Box flexDirection="column" marginLeft={4} marginTop={1} marginBottom={1}>
                    <Text dimColor>{issue.description}</Text>
                    {issue.evidence.map((ev, i) => (
                      <Text key={i} dimColor>
                        Location: <Text color="yellow">{ev.file}{ev.line ? `:${ev.line}` : ""}</Text>
                        {ev.snippet ? ` - "${ev.snippet}"` : ""}
                      </Text>
                    ))}
                    {issue.recommendation && (
                      <Text color="green">Fix: {issue.recommendation}</Text>
                    )}
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};
