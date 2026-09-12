import React from "react";
import { Box, Text } from "ink";
import { EffectiveContextReport } from "../../analyzers/context/effectiveTypes.js";
import { ScanResult } from "../../core/types.js";

interface ContextViewProps {
  result: ScanResult;
  report: EffectiveContextReport;
  selectedIndex: number;
}

export interface ContextViewModel {
  title: string;
  budget: string;
  promptSources: string[];
  candidates: string[];
  capabilities: string[];
  diagnostics: string[];
}

export function buildContextViewModel(report: EffectiveContextReport): ContextViewModel {
  const window = report.budget.contextWindowTokens === null
    ? "window unknown"
    : `${report.budget.usagePercent}% of ${report.budget.contextWindowTokens.toLocaleString()}`;
  return {
    title: `${report.profile.name} · ${report.query.targetPaths.length} target path(s)`,
    budget: `${report.budget.promptTokens.toLocaleString()} estimated prompt tokens · ${report.budget.candidateTokens.toLocaleString()} candidate tokens · ${window}`,
    promptSources: report.prompt.map((entry) => `${entry.status === "loaded" ? "✓" : "!"} ${entry.source}${entry.line ? `:${entry.line}` : ""} — ${entry.matchReason}`),
    candidates: report.candidates.map((entry) => `○ ${entry.name || entry.source} — ${entry.matchReason}`),
    capabilities: report.capabilities.map((capability) => `${["selected", "matched", "available"].includes(capability.status) ? "✓" : "○"} ${capability.kind}:${capability.name} — ${capability.status}`),
    diagnostics: report.diagnostics.map((diagnostic) => `${diagnostic.severity === "error" ? "✕" : diagnostic.severity === "warning" ? "!" : "i"} ${diagnostic.code}: ${diagnostic.message}`),
  };
}

function LimitedList({ items, empty, limit }: { items: string[]; empty: string; limit: number }) {
  if (items.length === 0) return <Text dimColor>  {empty}</Text>;
  return (
    <>
      {items.slice(0, limit).map((item, index) => <Text key={`${index}-${item}`}>  {item}</Text>)}
      {items.length > limit && <Text dimColor>  … {items.length - limit} more</Text>}
    </>
  );
}

export const ContextView: React.FC<ContextViewProps> = ({ result, report, selectedIndex }) => {
  const model = buildContextViewModel(report);
  const contextFindings = result.findings.filter((finding) => finding.category === "context");
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="cyan">Effective Context · {model.title}</Text>
          <Text dimColor>[ / ] switch agent · r rerun</Text>
        </Box>
        <Text>{model.budget}</Text>
        <Text dimColor>Static simulation; hooks and MCP servers are not executed.</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Prompt loading chain ({model.promptSources.length})</Text>
        <LimitedList items={model.promptSources} empty="No prompt instructions loaded." limit={7} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Candidates ({model.candidates.length})</Text>
        <LimitedList items={model.candidates} empty="None." limit={4} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Capabilities ({model.capabilities.length})</Text>
        <LimitedList items={model.capabilities} empty="None discovered." limit={5} />
      </Box>
      {model.diagnostics.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">Diagnostics ({model.diagnostics.length})</Text>
          <LimitedList items={model.diagnostics} empty="None." limit={4} />
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Existing context health findings ({contextFindings.length})</Text>
        {contextFindings.slice(0, 4).map((issue, index) => (
          <Text key={issue.id} color={index === selectedIndex ? "cyan" : undefined}>
            {index === selectedIndex ? ">" : " "} {issue.severity.toUpperCase()} · {issue.title}
          </Text>
        ))}
      </Box>
    </Box>
  );
};
