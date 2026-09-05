import React from "react";
import { Box, Text } from "ink";
import { ScanResult, Finding } from "../../core/types.js";
import { ProgressBar } from "../components/ProgressBar.js";

interface OverviewViewProps {
  result: ScanResult;
  selectedIndex: number;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ result, selectedIndex }) => {
  const { overallScore, scores, findings } = result;

  let scoreColor: "green" | "yellow" | "red" = "green";
  if (overallScore < 60) scoreColor = "red";
  else if (overallScore < 75) scoreColor = "yellow";

  const topIssues = findings.filter((f) => (f.confidence ?? 0.85) >= 0.8).slice(0, 6);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Top section: Score and Category Breakdown */}
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-around">
        <Box flexDirection="column" alignItems="center" justifyContent="center">
          <Text dimColor>Agent Efficiency Score</Text>
          <Box marginTop={1}>
            <Text bold color={scoreColor}>
              {"  "}{overallScore}{"  "}
            </Text>
          </Box>
          <Text dimColor>/ 100</Text>
          {result.scoreExplanation && (
            <Box marginTop={1}>
              <Text dimColor>{result.scoreExplanation}</Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" justifyContent="center" gap={1}>
          <ProgressBar label="Context Health" score={scores.context.score} />
          <ProgressBar label="Repository Readiness" score={scores.repository.score} />
          <ProgressBar label="Verification Loop" score={scores.verification.score} />
          {scores.runtime ? (
            <ProgressBar label="Runtime Efficiency" score={scores.runtime.score} />
          ) : (
            <Box width={38} justifyContent="space-between">
              <Text bold>Runtime Efficiency</Text>
              <Text dimColor>[No session data]</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Bottom section: Top Issues */}
      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between" marginBottom={1}>
          <Text bold underline>Top Issues ({findings.length} total)</Text>
          {result.availableFixes.length > 0 && (
            <Text color="green" bold>
              ⚡ {result.availableFixes.length} fixes available (press 'f' to review)
            </Text>
          )}
        </Box>

        {topIssues.length === 0 ? (
          <Box borderStyle="round" borderColor="green" padding={1}>
            <Text color="green">✓ No efficiency issues detected. Your repository is AI Agent Ready!</Text>
          </Box>
        ) : (
          topIssues.map((issue, idx) => {
            const isSelected = idx === selectedIndex;
            let badge = <Text color="blue">▼ LOW </Text>;
            if (issue.severity === "critical" || issue.severity === "high") {
              badge = <Text bold color="red">▲ HIGH</Text>;
            } else if (issue.severity === "medium") {
              badge = <Text bold color="yellow">● MED </Text>;
            }

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
                  {badge}
                  <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
                    {issue.title} <Text dimColor>({Math.round((issue.confidence ?? 0.85) * 100)}%)</Text>
                  </Text>
                </Box>
                {isSelected && (
                  <Box flexDirection="column" marginLeft={4} marginTop={1} marginBottom={1}>
                    <Text dimColor>{issue.description}</Text>
                    {issue.evidence[0] && (
                      <Text dimColor>
                        Location: <Text color="yellow">{issue.evidence[0].file}</Text>
                        {issue.evidence[0].line ? `:${issue.evidence[0].line}` : ""}
                      </Text>
                    )}
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
