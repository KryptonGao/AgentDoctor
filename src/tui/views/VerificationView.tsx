import React from "react";
import { Box, Text } from "ink";
import { ScanResult, VerificationItem } from "../../core/types.js";

interface VerificationViewProps {
  result: ScanResult;
  selectedIndex: number;
}

function renderStatusBadge(status: VerificationItem["status"]) {
  switch (status) {
    case "healthy":
      return <Text color="green" bold>✓ Healthy</Text>;
    case "warning":
      return <Text color="yellow" bold>⚠ Warning</Text>;
    case "broken":
      return <Text color="red" bold>✕ Broken </Text>;
    case "unknown":
      return <Text dimColor>? Unknown</Text>;
    case "not_applicable":
      return <Text dimColor>— N/A    </Text>;
  }
}

export const VerificationView: React.FC<VerificationViewProps> = ({ result, selectedIndex }) => {
  const { scores, verificationStatus, findings } = result;
  const verifFindings = findings.filter((f) => f.category === "verification");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="cyan">Verification Readiness: {scores.verification.score} / 100</Text>
          <Text dimColor>Ensures AI coding agents have a reliable feedback loop to verify changes.</Text>
        </Box>
      </Box>

      {/* Verification status table */}
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginTop={1} paddingX={1}>
        <Box justifyContent="space-between" borderStyle="single" borderColor="gray">
          <Box width={16}><Text bold>Target</Text></Box>
          <Box width={16}><Text bold>Status</Text></Box>
          <Box width={36}><Text bold>Command / Details</Text></Box>
        </Box>

        {verificationStatus.map((item) => (
          <Box key={item.name} justifyContent="space-between" marginY={0}>
            <Box width={16}><Text bold>{item.name.toUpperCase()}</Text></Box>
            <Box width={16}>{renderStatusBadge(item.status)}</Box>
            <Box width={36}><Text dimColor>{item.command || item.detail || "Not configured"}</Text></Box>
          </Box>
        ))}
      </Box>

      {/* Verification findings */}
      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text bold underline>Verification Findings ({verifFindings.length})</Text>
        </Box>

        {verifFindings.length === 0 ? (
          <Box borderStyle="round" borderColor="green" padding={1}>
            <Text color="green">✓ All verification commands are healthy, consistent, and discoverable!</Text>
          </Box>
        ) : (
          verifFindings.map((issue, idx) => {
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
                        Evidence: <Text color="yellow">{ev.file}</Text> {ev.snippet ? `(${ev.snippet})` : ""}
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
