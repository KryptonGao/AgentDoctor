import { SessionMetrics } from "../../core/types.js";

export type NativeAgentId = "codex" | "claude" | "cursor" | "gemini" | "agentdoctor" | "otel";

export interface RawSessionRef {
  agent: NativeAgentId;
  sourcePath: string;
  mtime: number;
}

export interface SessionAdapter {
  id: NativeAgentId;
  /** Repo-local + global same-repo matches. Must never throw. */
  detect(repoRoot: string): Promise<RawSessionRef[]>;
  /** Parse one ref. Returns null on unparseable content (tolerate bad lines). */
  parse(ref: RawSessionRef): Promise<SessionMetrics | null>;
  /** Optional multi-session parse (OTLP files hold many traces). */
  parseMany?(ref: RawSessionRef): Promise<SessionMetrics[]>;
  /** Quick probe for explicit --session files. */
  canParseFile?(filePath: string, firstChunk: string): boolean;
}

/** Adapter-produced partial session before scoring/repeat-aggregation. */
export interface PartialSession extends Omit<
  SessionMetrics,
  "efficiencyScore" | "repeatedReads" | "repeatedSearches" | "repeatedFailures"
> {
  // efficiencyScore + repeats are computed by finalizeSession()
}

export function formatTimeOffset(offsetSeconds: number): string {
  const s = Math.max(0, Math.floor(offsetSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
