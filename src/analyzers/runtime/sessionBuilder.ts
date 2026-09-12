import { SessionMetrics } from "../../core/types.js";
import { PartialSession } from "./sessionTypes.js";

export interface SessionRepeats {
  repeatedReads: { file: string; count: number }[];
  repeatedSearches: { query: string; count: number }[];
  repeatedFailures: { command: string; count: number }[];
}

/**
 * Derive repeat signals from the raw normalized events. Kept public so the
 * privacy pass can recompute derived values after replacing sensitive text.
 */
export function deriveSessionRepeats(
  filesRead: string[],
  searchOperations: string[],
  timeline: PartialSession["timeline"]
): SessionRepeats {
  const fileReadCounts: Record<string, number> = {};
  for (const f of filesRead) fileReadCounts[f] = (fileReadCounts[f] || 0) + 1;
  const repeatedReads = Object.entries(fileReadCounts)
    .filter(([, count]) => count >= 3)
    .map(([file, count]) => ({ file, count }));

  const searchCounts: Record<string, number> = {};
  for (const s of searchOperations) {
    const norm = s.toLowerCase().trim();
    if (norm) searchCounts[norm] = (searchCounts[norm] || 0) + 1;
  }
  const repeatedSearches = Object.entries(searchCounts)
    .filter(([, count]) => count >= 2)
    .map(([query, count]) => ({ query, count }));

  const failedCmdCounts: Record<string, number> = {};
  for (const t of timeline) {
    if (t.status === "failed") failedCmdCounts[t.action] = (failedCmdCounts[t.action] || 0) + 1;
  }
  const repeatedFailures = Object.entries(failedCmdCounts)
    .filter(([, count]) => count >= 2)
    .map(([command, count]) => ({ command, count }));

  return { repeatedReads, repeatedSearches, repeatedFailures };
}

/**
 * Shared scoring + repeat aggregation. Single source of truth for all adapters
 * (legacy AgentDoctor JSON included). Never fabricates tokens/duration:
 * unknown stays 0 with *Unknown flags; score simply ignores missing signals.
 */
export function finalizeSession(partial: PartialSession): SessionMetrics {
  const { repeatedReads, repeatedSearches, repeatedFailures } = deriveSessionRepeats(
    partial.filesRead,
    partial.searchOperations,
    partial.timeline
  );

  // Derive failureReasons from failed timeline events when adapter didn't set them.
  let failureReasons = partial.failureReasons;
  if (!failureReasons) {
    failureReasons = partial.timeline
      .filter((t) => t.status === "failed")
      .slice(0, 20)
      .map((t) => ({ action: t.action, reason: t.detail || "failed" }));
  }

  const sessionScore = Math.max(
    30,
    Math.min(
      98,
      100 -
        repeatedReads.length * 8 -
        repeatedSearches.length * 6 -
        repeatedFailures.length * 12 -
        Math.min(20, Math.floor(partial.failedToolCalls * 2))
    )
  );

  return {
    ...partial,
    tokenUsage: {
      input: partial.tokenUsage?.input || 0,
      output: partial.tokenUsage?.output || 0,
      total:
        partial.tokenUsage?.total ||
        (partial.tokenUsage?.input || 0) + (partial.tokenUsage?.output || 0),
    },
    toolOutputTokens: partial.toolOutputTokens || 0,
    efficiencyScore: sessionScore,
    repeatedReads,
    repeatedSearches,
    repeatedFailures,
    failureReasons,
    approvalsCount: partial.approvalsCount || 0,
    retriesCount: partial.retriesCount || 0,
    restoresCount: partial.restoresCount || 0,
    redactedFields: partial.redactedFields || 0,
  };
}

export function emptyPartial(id: string, agentName: PartialSession["agentName"]): PartialSession {
  return {
    id,
    agentName,
    date: "Unknown",
    durationSeconds: 0,
    durationUnknown: true,
    tokenUsage: { input: 0, output: 0, total: 0 },
    tokensUnknown: true,
    toolCalls: 0,
    failedToolCalls: 0,
    commandsExecuted: 0,
    filesRead: [],
    filesEdited: [],
    searchOperations: [],
    toolOutputTokens: 0,
    timeline: [],
  };
}
