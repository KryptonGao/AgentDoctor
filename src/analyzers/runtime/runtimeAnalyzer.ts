import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import { Finding, SessionMetrics, SessionTimelineEvent, Evidence } from "../../core/types.js";
import { estimateTokens } from "../context/tokenCounter.js";

export function parseSessionTrace(content: string, filePath: string): SessionMetrics | null {
  try {
    const data = JSON.parse(content);
    // Support standard AgentDoctor format or Claude / Codex trace structures
    const id = data.id || path.basename(filePath, path.extname(filePath));
    const agentName = data.agentName || (data.model?.includes("claude") ? "Claude Code" : "Codex");
    const date = data.date || "Today";
    const durationSeconds = data.durationSeconds || 900;

    const filesRead: string[] = data.filesRead || [];
    const filesEdited: string[] = data.filesEdited || [];
    const searchOperations: string[] = data.searchOperations || [];
    const timeline: SessionTimelineEvent[] = data.timeline || [];

    // Extract tool calls and events from timeline if available
    let toolCalls = data.toolCalls || timeline.length;
    let failedToolCalls = data.failedToolCalls || timeline.filter((t) => t.status === "failed").length;
    let commandsExecuted = data.commandsExecuted || 0;
    let toolOutputTokens = data.toolOutputTokens || 0;

    // Track repeated file reads
    const fileReadCounts: Record<string, number> = {};
    for (const f of filesRead) {
      fileReadCounts[f] = (fileReadCounts[f] || 0) + 1;
    }
    // Also parse from timeline if timeline exists
    for (const t of timeline) {
      if (t.action.toLowerCase().includes("read ") || t.action.toLowerCase().includes("view ")) {
        const match = t.action.match(/(?:read|view)\s+([a-zA-Z0-9_\-./]+)/i);
        if (match && match[1]) {
          const file = match[1];
          fileReadCounts[file] = (fileReadCounts[file] || 0) + 1;
          if (!filesRead.includes(file)) filesRead.push(file);
        }
      }
      if (t.action.toLowerCase().includes("search ") || t.action.toLowerCase().includes("grep ")) {
        const match = t.action.match(/(?:search|grep)\s+([^\n]+)/i);
        if (match && match[1]) {
          const query = match[1].replace(/['"]/g, "").trim();
          searchOperations.push(query);
        }
      }
      if (t.action.toLowerCase().includes("edit ") || t.action.toLowerCase().includes("write ")) {
        const match = t.action.match(/(?:edit|write)\s+([a-zA-Z0-9_\-./]+)/i);
        if (match && match[1]) {
          const file = match[1];
          if (!filesEdited.includes(file)) filesEdited.push(file);
        }
      }
      if (t.tool === "bash" || t.tool === "command" || t.action.toLowerCase().startsWith("run ") || t.action.toLowerCase().includes("test")) {
        commandsExecuted++;
      }
    }

    const repeatedReads = Object.entries(fileReadCounts)
      .filter(([_, count]) => count >= 3)
      .map(([file, count]) => ({ file, count }));

    // Track repeated search queries
    const searchCounts: Record<string, number> = {};
    for (const s of searchOperations) {
      const norm = s.toLowerCase().trim();
      searchCounts[norm] = (searchCounts[norm] || 0) + 1;
    }
    const repeatedSearches = Object.entries(searchCounts)
      .filter(([_, count]) => count >= 2)
      .map(([query, count]) => ({ query, count }));

    // Track repeated failed commands
    const failedCmdCounts: Record<string, number> = {};
    for (const t of timeline) {
      if (t.status === "failed") {
        failedCmdCounts[t.action] = (failedCmdCounts[t.action] || 0) + 1;
      }
    }
    const repeatedFailures = Object.entries(failedCmdCounts)
      .filter(([_, count]) => count >= 2)
      .map(([command, count]) => ({ command, count }));

    const tokenUsage = data.tokenUsage || {
      input: 65000,
      output: 12000,
      total: 77000,
    };

    const sessionScore = Math.max(
      30,
      Math.min(
        98,
        100 -
          repeatedReads.length * 8 -
          repeatedSearches.length * 6 -
          repeatedFailures.length * 12 -
          Math.min(20, Math.floor(failedToolCalls * 2))
      )
    );

    return {
      id,
      agentName,
      date,
      efficiencyScore: sessionScore,
      durationSeconds,
      tokenUsage,
      toolCalls,
      failedToolCalls,
      commandsExecuted,
      filesRead,
      filesEdited,
      searchOperations,
      toolOutputTokens: toolOutputTokens || 12000,
      timeline,
      repeatedReads,
      repeatedSearches,
      repeatedFailures,
    };
  } catch {
    return null;
  }
}

export async function analyzeRuntimeSessions(
  repoRoot: string,
  explicitSessionPath?: string
): Promise<{
  findings: Finding[];
  sessions: SessionMetrics[];
}> {
  const findings: Finding[] = [];
  const sessions: SessionMetrics[] = [];

  const candidatePaths: string[] = [];

  if (explicitSessionPath && fs.existsSync(explicitSessionPath)) {
    candidatePaths.push(explicitSessionPath);
  } else {
    const sessionFiles = await fg(
      [
        ".agent/sessions/*.json",
        ".claude/sessions/*.json",
        ".sessions/*.json",
        "sessions/*.json",
      ],
      { cwd: repoRoot, dot: true, onlyFiles: true }
    );
    for (const f of sessionFiles.sort((a, b) => a.localeCompare(b))) {
      candidatePaths.push(path.join(repoRoot, f));
    }
  }

  for (const p of candidatePaths) {
    try {
      const content = fs.readFileSync(p, "utf-8");
      const session = parseSessionTrace(content, p);
      if (session) {
        sessions.push(session);

        // 1. Repeated Reads Findings
        for (const rr of session.repeatedReads) {
          findings.push({
            id: `runtime-repeated-read-${rr.file.replace(/[^a-zA-Z0-9]/g, "-")}`,
            ruleId: "runtime/repeated-file-retrieval",
            category: "runtime",
            severity: "medium",
            confidence: 0.90,
            title: `Repeated file retrieval: ${rr.file} (${rr.count} times)`,
            description: `${rr.file} was read ${rr.count} times in session ${session.id}. AI agents repeatedly retrieve files when instruction context lacks clear summaries or architectural relationships.`,
            evidence: [
              {
                file: rr.file,
                snippet: `Retrieved ${rr.count} times in session ${session.id}`,
                source: path.relative(repoRoot, p),
              },
            ],
            impact: {
              tokens: rr.count * 1200,
              latency: rr.count * 3,
            },
            recommendation: `Add module summary or export structure of ${rr.file} to repository context docs so agent remembers interface without re-reading.`,
          });
        }

        // 2. Repeated Searches Findings
        for (const rs of session.repeatedSearches) {
          findings.push({
            id: `runtime-repeated-search-${rs.query.replace(/[^a-zA-Z0-9]/g, "-")}`,
            ruleId: "runtime/repeated-searches",
            category: "runtime",
            severity: "medium",
            confidence: 0.85,
            title: `Repeated search operations for "${rs.query}" (${rs.count} times)`,
            description: `Agent executed ${rs.count} repetitive search queries for "${rs.query}". Indicates poor directory discoverability or lack of documentation of key service locations.`,
            evidence: [
              {
                file: path.relative(repoRoot, p),
                snippet: `Query "${rs.query}" repeated ${rs.count} times`,
                source: "session trace",
              },
            ],
            recommendation: `Document the entry point or implementation directory for "${rs.query}" in AGENTS.md.`,
          });
        }

        // 3. Repeated Command Failures Findings
        for (const rf of session.repeatedFailures) {
          findings.push({
            id: `runtime-repeated-failure-${rf.command.replace(/[^a-zA-Z0-9]/g, "-")}`,
            ruleId: "runtime/repeated-command-failures",
            category: "runtime",
            severity: "high",
            confidence: 0.95,
            title: `Repeated failed command: "${rf.command}" (${rf.count} times)`,
            description: `Same command failed ${rf.count} times in session without successful configuration adjustments. Agent wasted turns in trial-and-error loop.`,
            evidence: [
              {
                file: path.relative(repoRoot, p),
                snippet: `Command "${rf.command}" failed ${rf.count} times`,
                source: "session trace",
              },
            ],
            impact: {
              reliability: 8,
            },
            recommendation: `Verify prerequisites for running "${rf.command}" or provide pre-run setup script in AGENTS.md.`,
          });
        }

        // 4. Oversized Tool Output Findings
        if (session.toolOutputTokens > 20000) {
          findings.push({
            id: `runtime-oversized-output-${session.id}`,
            ruleId: "runtime/oversized-tool-output",
            category: "runtime",
            severity: "medium",
            confidence: 0.85,
            title: `Tool output bloat detected (${session.toolOutputTokens.toLocaleString()} tokens)`,
            description: `Tool outputs consumed ${session.toolOutputTokens.toLocaleString()} tokens in session ${session.id}. Unfiltered logs or full build outputs flood agent context and dilute attention.`,
            evidence: [
              {
                file: path.relative(repoRoot, p),
                snippet: `${session.toolOutputTokens.toLocaleString()} tool output tokens`,
                source: "session trace",
              },
            ],
            impact: {
              tokens: session.toolOutputTokens - 4000,
            },
            recommendation: "Configure commands with quiet flags (e.g. `vitest run --reporter=basic` or `pnpm test --silent`).",
          });
        }
      }
    } catch {
      // ignore
    }
  }

  sessions.sort((a, b) => a.id.localeCompare(b.id));
  findings.sort((a, b) => (a.fingerprint || a.id).localeCompare(b.fingerprint || b.id));
  return { findings, sessions };
}
