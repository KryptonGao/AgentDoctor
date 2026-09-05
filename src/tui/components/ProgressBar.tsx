import React from "react";
import { Box, Text } from "ink";

interface ProgressBarProps {
  label: string;
  score: number;
  width?: number;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ label, score, width = 14 }) => {
  const filledCount = Math.max(0, Math.min(width, Math.round((score / 100) * width)));
  const emptyCount = width - filledCount;

  const filled = "█".repeat(filledCount);
  const empty = "░".repeat(emptyCount);

  let color: "green" | "yellow" | "red" = "green";
  if (score < 60) color = "red";
  else if (score < 75) color = "yellow";

  return (
    <Box justifyContent="space-between" width={38}>
      <Text bold>{label.padEnd(16)}</Text>
      <Box>
        <Text color={color}>{filled}</Text>
        <Text dimColor>{empty}</Text>
        <Text bold color={color}> {String(score).padStart(3)}</Text>
      </Box>
    </Box>
  );
};
