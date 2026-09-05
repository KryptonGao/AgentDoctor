import React from "react";
import { Box, Text } from "ink";
import { Finding } from "../../core/types.js";
import { generateFixPrompt } from "../../core/prompt/promptGenerator.js";

interface PromptPreviewModalProps {
  finding: Finding;
  scrollOffset?: number;
}

export const PromptPreviewModal: React.FC<PromptPreviewModalProps> = ({
  finding,
  scrollOffset = 0,
}) => {
  const prompt = finding.fixPrompt || generateFixPrompt(finding);
  const lines = prompt.split("\n");
  const visibleLines = lines.slice(scrollOffset, scrollOffset + 18);

  let badge = <Text color="blue">LOW</Text>;
  if (finding.severity === "critical" || finding.severity === "high") {
    badge = <Text bold color="red">▲ HIGH</Text>;
  } else if (finding.severity === "medium") {
    badge = <Text bold color="yellow">● MED</Text>;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} marginX={1}>
      {/* Header */}
      <Box justifyContent="space-between" borderStyle="single" borderColor="gray" paddingBottom={0}>
        <Box gap={1}>
          <Text bold color="cyan">┌─ Fix Prompt Preview ──</Text>
          {badge}
          <Text bold>{finding.title}</Text>
          <Text dimColor>({Math.round((finding.confidence ?? 0.85) * 100)}% conf)</Text>
        </Box>
        <Text color="green" bold>[c] Copy Prompt  [Esc] Back</Text>
      </Box>

      {/* Prompt Body */}
      <Box
        flexDirection="column"
        marginTop={1}
        paddingX={1}
        borderStyle="single"
        borderColor="gray"
        minHeight={12}
      >
        {visibleLines.map((line, idx) => {
          if (line.startsWith("## ")) {
            return (
              <Text key={idx} bold color="cyan">
                {line}
              </Text>
            );
          }
          if (line.startsWith("### ")) {
            return (
              <Text key={idx} bold color="yellow">
                {line}
              </Text>
            );
          }
          if (line.startsWith("- ")) {
            return (
              <Text key={idx} color="white">
                {"  "}{line}
              </Text>
            );
          }
          return (
            <Text key={idx} dimColor={line.trim() === ""}>
              {line}
            </Text>
          );
        })}
      </Box>

      {/* Footer Info */}
      <Box justifyContent="space-between" marginTop={1}>
        <Text dimColor>
          Evidence:{" "}
          {finding.evidence.length > 0
            ? finding.evidence
                .map((e) => `${e.file}${e.line ? `:${e.line}` : ""}`)
                .slice(0, 3)
                .join(", ")
            : "Repository configuration"}
        </Text>
        <Text dimColor>
          Lines {scrollOffset + 1}-{Math.min(scrollOffset + 18, lines.length)} of {lines.length} (↑↓ to scroll)
        </Text>
      </Box>
    </Box>
  );
};
