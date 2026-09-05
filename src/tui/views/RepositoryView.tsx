import React from "react";
import { Box, Text } from "ink";
import { ScanResult } from "../../core/types.js";

interface RepositoryViewProps {
  result: ScanResult;
  selectedIndex: number;
}

export const RepositoryView: React.FC<RepositoryViewProps> = ({ result, selectedIndex }) => {
  const { scores, findings } = result;
  const repoFindings = findings.filter((f) => f.category === "repository");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="cyan">Repository Readiness: {scores.repository.score} / 100</Text>
          <Text dimColor>Measures how easily an AI coding agent can navigate and modify the codebase.</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text dimColor>Scanned Files: <Text bold color="white">{result.metadata.scannedFilesCount}</Text></Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text bold underline>Repository Findings ({repoFindings.length})</Text>
        </Box>

        {repoFindings.length === 0 ? (
          <Box borderStyle="round" borderColor="green" padding={1}>
            <Text color="green">✓ Project structure is clean, modular, and easy for AI agents to navigate!</Text>
          </Box>
        ) : (
          repoFindings.map((issue, idx) => {
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
                        Location: <Text color="yellow">{ev.file}</Text>
                        {ev.snippet ? ` (${ev.snippet})` : ""}
                      </Text>
                    ))}
                    {issue.recommendation && (
                      <Text color="green">Recommendation: {issue.recommendation}</Text>
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
