import React from "react";
import { Box, Text } from "ink";
import { ScanResult } from "../../core/types.js";

interface SecurityViewProps {
  result: ScanResult;
  selectedIndex: number;
}

const RULE_LABELS: Record<string, string> = {
  "security/prompt-injection": "Prompt injection",
  "security/hidden-unicode": "Hidden Unicode",
  "security/instruction-secrets": "Instruction secrets",
  "security/dangerous-shell": "Dangerous shell",
  "security/mcp-hook-permissions": "MCP / hook permissions",
  "security/external-network": "External network",
  "security/generated-file-edit": "Generated file edits",
  "security/untrusted-content-injection": "Untrusted content",
};

export const SecurityView: React.FC<SecurityViewProps> = ({ result, selectedIndex }) => {
  const findings = result.findings.filter((finding) => finding.category === "security");
  const score = result.scores.security.score;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="cyan">Agent Security Audit: {score} / 100</Text>
          <Text dimColor>
            Static checks for injection, hidden Unicode, secrets, dangerous shell, MCP/hooks, network, generated edits, and untrusted README/issue/tool output.
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box marginBottom={1}>
          <Text bold underline>Security Findings ({findings.length})</Text>
        </Box>
        {findings.length === 0 ? (
          <Box borderStyle="round" borderColor="green" padding={1}>
            <Text color="green">✓ No agent security issues detected in instructions, MCP, or hooks.</Text>
          </Box>
        ) : (
          findings.map((issue, idx) => {
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
                  <Text bold color={issue.severity === "critical" || issue.severity === "high" ? "red" : issue.severity === "medium" ? "yellow" : "blue"}>
                    {issue.severity.toUpperCase().padEnd(8)}
                  </Text>
                  <Text dimColor>{RULE_LABELS[issue.ruleId] || issue.ruleId}</Text>
                  <Text bold={isSelected}>{issue.title}</Text>
                </Box>
                {isSelected && (
                  <Box flexDirection="column" marginLeft={4} marginTop={1} marginBottom={1}>
                    <Text dimColor>{issue.description}</Text>
                    {issue.evidence.map((ev, i) => (
                      <Text key={i} dimColor>
                        Location: <Text color="yellow">{ev.file}{ev.line ? `:${ev.line}` : ""}</Text>
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
