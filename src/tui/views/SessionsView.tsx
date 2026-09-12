import React from "react";
import { Box, Text } from "ink";
import { ScanResult } from "../../core/types.js";

interface SessionsViewProps {
  result: ScanResult;
  selectedSessionIndex: number;
}

export const SessionsView: React.FC<SessionsViewProps> = ({ result, selectedSessionIndex }) => {
  const { sessions, scores } = result;

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box borderStyle="single" borderColor="gray" padding={1}>
          <Text bold color="yellow">No Agent Sessions Found</Text>
        </Box>
        <Box marginTop={1} padding={1} flexDirection="column">
          <Text dimColor>
            AgentDoctor scans repo-local traces plus global native logs for this repo:
          </Text>
          <Text color="cyan">  .agent/sessions/*.json(.jsonl), .claude/sessions/, sessions/</Text>
          <Text color="cyan">  ~/.codex/sessions (same-repo), ~/.claude/projects (same-repo)</Text>
          <Text color="cyan">  ~/.gemini/tmp/&lt;project-hash&gt;/chats, ~/.cursor/projects/&lt;cwd&gt;/agent-transcripts/</Text>
          <Text color="cyan">  OTLP/HTTP JSON traces via --session or `agentdoctor otel`</Text>
          <Text dimColor>Skip global dirs with --no-global. Secrets are redacted by default.</Text>
        </Box>
      </Box>
    );
  }

  const activeSession = sessions[selectedSessionIndex] || sessions[0];

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Session list header */}
      <Box borderStyle="single" borderColor="gray" padding={1} justifyContent="space-between">
        <Box flexDirection="column">
          <Text bold color="cyan">Runtime Efficiency: {scores.runtime?.score ?? 80} / 100</Text>
          <Text dimColor>{sessions.length} recorded coding agent sessions</Text>
        </Box>
      </Box>

      {/* Two columns: Session list on left, timeline on right */}
      <Box marginTop={1} justifyContent="space-between">
        {/* Left column: sessions */}
        <Box flexDirection="column" width="35%" borderStyle="round" borderColor="gray" paddingX={1}>
          <Box marginBottom={1}>
            <Text bold underline>Sessions</Text>
          </Box>
          {sessions.map((s, idx) => {
            const isSelected = idx === selectedSessionIndex;
            return (
              <Box key={s.id} gap={1}>
                <Text color={isSelected ? "cyan" : undefined}>{isSelected ? ">" : " "} </Text>
                <Text bold={isSelected}>{s.agentName}</Text>
                <Text dimColor>{s.date}</Text>
                <Text bold color={s.efficiencyScore >= 75 ? "green" : "yellow"}>
                  {s.efficiencyScore}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Right column: Session details and timeline */}
        <Box flexDirection="column" width="62%" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color="cyan">{activeSession.agentName} ({activeSession.id})</Text>
            <Text bold color="green">Score: {activeSession.efficiencyScore}/100</Text>
          </Box>
          <Box gap={2} marginTop={1}>
            <Text dimColor>Duration: <Text bold color="white">{activeSession.durationUnknown ? "n/a" : `${Math.round(activeSession.durationSeconds / 60)}m`}</Text></Text>
            <Text dimColor>Tokens: <Text bold color="white">{activeSession.tokensUnknown ? "n/a" : `${Math.round(activeSession.tokenUsage.total / 1000)}k`}</Text></Text>
            <Text dimColor>Tool calls: <Text bold color="white">{activeSession.toolCalls}</Text></Text>
            <Text dimColor>Failures: <Text bold color={activeSession.failedToolCalls > 0 ? "red" : "green"}>{activeSession.failedToolCalls}</Text></Text>
          </Box>
          {(activeSession.model || activeSession.gitCommit || activeSession.prNumber !== undefined ||
            (activeSession.approvalsCount || 0) > 0 || (activeSession.retriesCount || 0) > 0 ||
            (activeSession.redactedFields || 0) > 0 || activeSession.contextWindowTokens !== undefined) && (
            <Box gap={2} marginTop={1}>
              {activeSession.model && <Text dimColor>Model: <Text color="white">{activeSession.model}</Text></Text>}
              {activeSession.gitCommit && <Text dimColor>Commit: <Text color="white">{activeSession.gitCommit.slice(0, 8)}{activeSession.gitDirty ? "*" : ""}</Text></Text>}
              {activeSession.prNumber !== undefined && <Text dimColor>PR: <Text color="white">#{activeSession.prNumber} {activeSession.prState || ""}</Text></Text>}
              {(activeSession.approvalsCount || 0) > 0 && <Text dimColor>Approvals: <Text color="white">{activeSession.approvalsCount}</Text></Text>}
              {(activeSession.retriesCount || 0) > 0 && <Text dimColor>Retries: <Text color="white">{activeSession.retriesCount}</Text></Text>}
              {activeSession.contextWindowTokens !== undefined && <Text dimColor>Context: <Text color="white">{Math.round(activeSession.contextWindowTokens / 1000)}k</Text></Text>}
              {(activeSession.redactedFields || 0) > 0 && <Text dimColor>Redacted: <Text color="yellow">{activeSession.redactedFields}</Text></Text>}
            </Box>
          )}
          {activeSession.taskTitle && (
            <Box marginTop={1}>
              <Text dimColor>Task: <Text color="white">{activeSession.taskTitle.slice(0, 80)}</Text></Text>
            </Box>
          )}
          {(activeSession.failureReasons || []).length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="red">Failure reasons:</Text>
              {activeSession.failureReasons!.slice(0, 3).map((f, idx) => (
                <Text key={idx} dimColor>  - {f.reason.slice(0, 120)}</Text>
              ))}
            </Box>
          )}

          {/* Repeated operations warnings */}
          {activeSession.repeatedReads.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text bold color="yellow">Repeated File Reads:</Text>
              {activeSession.repeatedReads.map((rr) => (
                <Text key={rr.file} dimColor>  - {rr.file} (read {rr.count} times)</Text>
              ))}
            </Box>
          )}

          {/* Timeline events */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold underline>Timeline</Text>
            {activeSession.timeline.slice(0, 8).map((t, idx) => (
              <Box key={idx} gap={1}>
                <Text dimColor>{t.timeOffset}</Text>
                <Text color={t.status === "failed" ? "red" : "white"}>{t.action}</Text>
                {t.status === "failed" && <Text color="red">[failed]</Text>}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
