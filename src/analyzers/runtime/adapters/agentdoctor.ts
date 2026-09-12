import * as fs from "node:fs";
import * as path from "node:path";
import { SessionMetrics, SessionTimelineEvent } from "../../../core/types.js";
import { estimateTokens } from "../../context/tokenCounter.js";
import { finalizeSession, emptyPartial } from "../sessionBuilder.js";
import { RawSessionRef, SessionAdapter } from "../sessionTypes.js";

/**
 * Legacy AgentDoctor session JSON (backward compat).
 * Unlike the old implementation, missing duration/tokens stay unknown (0 + flag)
 * instead of fabricated 900s / 65k+12k tokens.
 */
export function parseAgentdoctorContent(content: string, filePath: string): SessionMetrics | null {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const id = data.id || path.basename(filePath, path.extname(filePath));
  const agentName =
    data.agentName ||
    (typeof data.model === "string" && data.model.includes("claude") ? "Claude Code" : "Codex");

  const partial = emptyPartial(String(id), agentName);
  partial.sourcePath = filePath;
  partial.date = data.date || "Unknown";
  if (typeof data.nativeId === "string") partial.nativeId = data.nativeId;
  if (typeof data.sessionCwd === "string") partial.sessionCwd = data.sessionCwd;
  if (typeof data.gitBranch === "string") partial.gitBranch = data.gitBranch;
  if (typeof data.gitCommit === "string") partial.gitCommit = data.gitCommit;
  if (typeof data.gitDirty === "boolean") partial.gitDirty = data.gitDirty;
  if (typeof data.gitMessage === "string") partial.gitMessage = data.gitMessage;
  if (typeof data.prNumber === "number") partial.prNumber = data.prNumber;
  if (typeof data.prTitle === "string") partial.prTitle = data.prTitle;
  if (typeof data.prState === "string") partial.prState = data.prState;
  if (typeof data.taskTitle === "string") partial.taskTitle = data.taskTitle;
  if (typeof data.contextTokens === "number") partial.contextTokens = data.contextTokens;
  if (typeof data.contextWindowTokens === "number") partial.contextWindowTokens = data.contextWindowTokens;

  if (typeof data.durationSeconds === "number" && data.durationSeconds >= 0) {
    partial.durationSeconds = data.durationSeconds;
    partial.durationUnknown = false;
  }
  if (typeof data.startedAtMs === "number" && Number.isFinite(data.startedAtMs)) {
    partial.startedAtMs = data.startedAtMs;
  }
  if (typeof data.endedAtMs === "number" && Number.isFinite(data.endedAtMs)) {
    partial.endedAtMs = data.endedAtMs;
  }
  if (partial.startedAtMs === undefined && typeof data.date === "string") {
    const parsedDate = Date.parse(data.date);
    if (Number.isFinite(parsedDate)) partial.startedAtMs = parsedDate;
  }
  if (partial.endedAtMs === undefined && partial.startedAtMs !== undefined && !partial.durationUnknown) {
    partial.endedAtMs = partial.startedAtMs + partial.durationSeconds * 1000;
  }

  partial.filesRead = Array.isArray(data.filesRead) ? [...data.filesRead] : [];
  partial.filesEdited = Array.isArray(data.filesEdited) ? [...data.filesEdited] : [];
  partial.searchOperations = Array.isArray(data.searchOperations) ? [...data.searchOperations] : [];
  partial.timeline = Array.isArray(data.timeline) ? [...data.timeline] : [];

  // Mine structured signals from timeline action strings (legacy heuristic, kept).
  let commandsExecuted = typeof data.commandsExecuted === "number" ? data.commandsExecuted : 0;
  for (const t of partial.timeline as SessionTimelineEvent[]) {
    const action = (t.action || "").toLowerCase();
    if (t.action.toLowerCase().includes("read ") || t.action.toLowerCase().includes("view ")) {
      const match = t.action.match(/(?:read|view)\s+([a-zA-Z0-9_\-./]+)/i);
      if (match?.[1]) {
        const file = match[1];
        if (!partial.filesRead.includes(file)) partial.filesRead.push(file);
        else partial.filesRead.push(file); // count repeats
      }
    }
    if (action.includes("search ") || action.includes("grep ")) {
      const match = t.action.match(/(?:search|grep)\s+([^\n]+)/i);
      if (match?.[1]) partial.searchOperations.push(match[1].replace(/['"]/g, "").trim());
    }
    if (action.includes("edit ") || action.includes("write ")) {
      const match = t.action.match(/(?:edit|write)\s+([a-zA-Z0-9_\-./]+)/i);
      if (match?.[1] && !partial.filesEdited.includes(match[1])) partial.filesEdited.push(match[1]);
    }
    if (t.tool === "bash" || t.tool === "command" || action.startsWith("run ") || action.includes("test")) {
      commandsExecuted++;
    }
  }
  partial.commandsExecuted = commandsExecuted;
  partial.toolCalls =
    typeof data.toolCalls === "number" ? data.toolCalls : partial.timeline.length;
  partial.failedToolCalls =
    typeof data.failedToolCalls === "number"
      ? data.failedToolCalls
      : partial.timeline.filter((t) => t.status === "failed").length;

  if (data.tokenUsage && typeof data.tokenUsage === "object") {
    const input = Number(data.tokenUsage.input) || 0;
    const output = Number(data.tokenUsage.output) || 0;
    const total = Number(data.tokenUsage.total) || input + output;
    partial.tokenUsage = { input, output, total };
    partial.tokensUnknown = total === 0;
  }

  if (typeof data.toolOutputTokens === "number") {
    partial.toolOutputTokens = data.toolOutputTokens;
  } else {
    // Estimate from timeline details instead of fabricating 12000.
    partial.toolOutputTokens = partial.timeline.reduce(
      (sum, t) => sum + estimateTokens(t.detail || ""),
      0
    );
  }

  if (typeof data.model === "string") partial.model = data.model;
  if (data.cacheTokens) partial.cacheTokens = data.cacheTokens;
  if (typeof data.approvalsCount === "number") partial.approvalsCount = data.approvalsCount;
  if (typeof data.retriesCount === "number") partial.retriesCount = data.retriesCount;
  if (typeof data.restoresCount === "number") partial.restoresCount = data.restoresCount;
  if (Array.isArray(data.failureReasons)) partial.failureReasons = [...data.failureReasons];
  if (typeof data.tokensUnknown === "boolean") partial.tokensUnknown = data.tokensUnknown;
  if (typeof data.durationUnknown === "boolean") partial.durationUnknown = data.durationUnknown;

  return finalizeSession(partial);
}

export const agentdoctorAdapter: SessionAdapter = {
  id: "agentdoctor",
  async detect(): Promise<RawSessionRef[]> {
    return []; // repo-local globs handled by orchestrator for back-compat
  },
  async parse(ref: RawSessionRef): Promise<SessionMetrics | null> {
    try {
      const content = fs.readFileSync(ref.sourcePath, "utf-8");
      return parseAgentdoctorContent(content, ref.sourcePath);
    } catch {
      return null;
    }
  },
  canParseFile(filePath: string, firstChunk: string): boolean {
    if (!filePath.endsWith(".json")) return false;
    const t = firstChunk.trimStart();
    return t.startsWith("{");
  },
};
